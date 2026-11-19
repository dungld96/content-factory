import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import {
  deadLetterPayloadSchema,
  GENERATION_DLQ,
  GENERATION_QUEUE,
  generationJobOptions,
  IMAGE_GENERATION_QUEUE,
  AUDIO_GENERATION_QUEUE,
  generationJobPayloadSchema,
  queueForKind,
  RETRY_POLICY,
  VIDEO_GENERATION_QUEUE,
  VIDEO_POLL_JOB_NAME,
  videoPollOptions,
  type DeadLetterPayload,
  type GenerationJobPayload,
} from '@acf/content-domain';

export { generationJobOptions };

import type { GenerationProcessor } from './generation-processor.js';
import type { Logger } from './logger.js';

/** BullMQ requires `maxRetriesPerRequest: null` on worker connections. */
export function redisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export interface Queues {
  readonly generation: Queue<GenerationJobPayload>;
  /** Image jobs (M4): own concurrency and lock duration. */
  readonly images: Queue<GenerationJobPayload>;
  /** Video jobs (M5): the submit (`generate`) and every status read (`poll`). */
  readonly videos: Queue<GenerationJobPayload>;
  /** TTS jobs (M5). */
  readonly audio: Queue<GenerationJobPayload>;
  readonly deadLetter: Queue<DeadLetterPayload>;
}

export function createQueues(connection: Redis, prefix: string): Queues {
  return {
    generation: new Queue<GenerationJobPayload>(GENERATION_QUEUE, { connection, prefix }),
    images: new Queue<GenerationJobPayload>(IMAGE_GENERATION_QUEUE, { connection, prefix }),
    videos: new Queue<GenerationJobPayload>(VIDEO_GENERATION_QUEUE, { connection, prefix }),
    audio: new Queue<GenerationJobPayload>(AUDIO_GENERATION_QUEUE, { connection, prefix }),
    deadLetter: new Queue<DeadLetterPayload>(GENERATION_DLQ, { connection, prefix }),
  };
}

/** The queue a job of `kind` lives on. */
export function queueOf(queues: Queues, kind: string): Queue<GenerationJobPayload> {
  switch (queueForKind(kind)) {
    case IMAGE_GENERATION_QUEUE:
      return queues.images;
    case VIDEO_GENERATION_QUEUE:
      return queues.videos;
    case AUDIO_GENERATION_QUEUE:
      return queues.audio;
    default:
      return queues.generation;
  }
}

/** BullMQ id of poll number `pollCount` of a video job. */
export const videoPollId = (jobId: string, pollCount: number): string =>
  videoPollOptions(jobId, pollCount, 0).jobId;

/**
 * Adds poll number `pollCount` of video job `jobId`. A finished BullMQ job with the same id (a
 * poll that ran but whose worker stopped before scheduling the next one) is replaced; a live one
 * is kept, so scheduling the same poll twice is harmless.
 */
export async function scheduleVideoPoll(
  queues: Queues,
  jobId: string,
  pollCount: number,
  delayMs: number,
): Promise<void> {
  const options = videoPollOptions(jobId, pollCount, delayMs);
  const existing = await queues.videos.getJob(options.jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return;
    await existing.remove();
  }
  await queues.videos.add(VIDEO_POLL_JOB_NAME, { jobId }, options);
}

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
  /** Default: the text queue (`generation`). */
  readonly queueName?: string;
}

/**
 * The BullMQ consumer: payload validation, then the processor. Outcomes map to BullMQ as:
 * retry → `RetryLaterError` (delay from the processor, via the `acf` backoff strategy); every
 * other outcome completes the BullMQ job, because PostgreSQL already holds the final state.
 */
export function startGenerationWorker(options: WorkerOptions): Worker<GenerationJobPayload> {
  const worker = new Worker<GenerationJobPayload>(
    options.queueName ?? GENERATION_QUEUE,
    async (job: Job<GenerationJobPayload>) => {
      const payload = generationJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new UnrecoverableError('invalid payload');
      const outcome = await options.processor.process(payload.data.jobId, job.name);
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
