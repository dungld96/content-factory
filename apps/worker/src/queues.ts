import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import {
  deadLetterPayloadSchema,
  GENERATION_DLQ,
  GENERATION_QUEUE,
  generationJobPayloadSchema,
  RETRY_POLICY,
  type DeadLetterPayload,
  type GenerationJobPayload,
} from '@acf/content-domain';

import type { GenerationProcessor } from './generation-processor.js';
import type { Logger } from './logger.js';

/** BullMQ requires `maxRetriesPerRequest: null` on worker connections. */
export function redisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export interface Queues {
  readonly generation: Queue<GenerationJobPayload>;
  readonly deadLetter: Queue<DeadLetterPayload>;
}

export function createQueues(connection: Redis, prefix: string): Queues {
  return {
    generation: new Queue<GenerationJobPayload>(GENERATION_QUEUE, { connection, prefix }),
    deadLetter: new Queue<DeadLetterPayload>(GENERATION_DLQ, { connection, prefix }),
  };
}

/** BullMQ job options for a generation job. The BullMQ id is the DB id: duplicate adds are no-ops. */
export const generationJobOptions = (jobId: string) => ({
  jobId,
  attempts: RETRY_POLICY.maxAttempts,
  backoff: { type: 'acf' },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600 },
});

/** Thrown to BullMQ to schedule the next attempt; carries the delay the processor decided. */
export class RetryLaterError extends Error {
  override readonly name = 'RetryLaterError';
  constructor(
    readonly errorCode: string,
    readonly delayMs: number,
  ) {
    super(`retry after ${String(delayMs)} ms (${errorCode})`);
  }
}

export async function addDeadLetter(queues: Queues, payload: DeadLetterPayload): Promise<void> {
  await queues.deadLetter.add('failed', deadLetterPayloadSchema.parse(payload), {
    // BullMQ rejects custom ids containing ':'.
    jobId: `${payload.jobId}-${String(payload.attempt)}`,
    removeOnComplete: false,
    removeOnFail: false,
  });
}

export interface WorkerOptions {
  readonly connection: Redis;
  readonly prefix: string;
  readonly concurrency: number;
  readonly processor: GenerationProcessor;
  readonly logger: Logger;
  /** Lock duration; a worker that stops renewing it is considered stalled. */
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
}

/**
 * The BullMQ consumer: payload validation, then the processor. Outcomes map to BullMQ as:
 * retry → `RetryLaterError` (delay from the processor, via the `acf` backoff strategy); every
 * other outcome completes the BullMQ job, because PostgreSQL already holds the final state.
 */
export function startGenerationWorker(options: WorkerOptions): Worker<GenerationJobPayload> {
  const worker = new Worker<GenerationJobPayload>(
    GENERATION_QUEUE,
    async (job: Job<GenerationJobPayload>) => {
      const payload = generationJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new UnrecoverableError('invalid payload');
      const outcome = await options.processor.process(payload.data.jobId);
      if (outcome.type === 'retry') throw new RetryLaterError(outcome.errorCode, outcome.delayMs);
      return outcome;
    },
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: options.concurrency,
      lockDuration: options.lockDurationMs ?? 30_000,
      stalledInterval: options.stalledIntervalMs ?? 30_000,
      maxStalledCount: RETRY_POLICY.maxAttempts,
      settings: {
        backoffStrategy: (_attemptsMade, _type, err) =>
          err instanceof RetryLaterError ? err.delayMs : RETRY_POLICY.baseDelayMs,
      },
    },
  );
  worker.on('error', (error) => {
    options.logger.log('error', 'worker_error', { error: error.name });
  });
  return worker;
}
