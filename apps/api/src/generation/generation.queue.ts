import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { ApiEnv } from '@acf/config';
import {
  AUDIO_GENERATION_QUEUE,
  GENERATION_DLQ,
  GENERATION_QUEUE,
  IMAGE_GENERATION_QUEUE,
  RENDER_QUEUE,
  generationJobOptions,
  queueForKind,
  VIDEO_GENERATION_QUEUE,
  VIDEO_POLL_JOB_NAME,
  videoPollOptions,
  type GenerationJobPayload,
} from '@acf/content-domain';

import { API_ENV } from '../config/api-config.module.js';

const ENQUEUE_TIMEOUT_MS = 3_000;

/**
 * Enqueue side of the generation queue (ADR-0013). The job row is already committed when this
 * runs; enqueueing is best effort and never fails the request: if Redis is unavailable the job
 * stays `queued` and the worker's reconciler enqueues it (outbox equivalent). The connection is
 * created lazily, so constructing the service has no I/O.
 */
@Injectable()
export class GenerationQueue implements OnModuleDestroy {
  private readonly logger = new Logger(GenerationQueue.name);
  private connection: Redis | undefined;
  /** One queue per kind group: text (`generation`) and images (`generation-images`, M4). */
  private readonly queues = new Map<string, Queue<GenerationJobPayload>>();

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /** Returns true when the job reached Redis. */
  async enqueue(jobId: string, kind = 'script_generation'): Promise<boolean> {
    try {
      const queue = this.getQueue(queueForKind(kind));
      await Promise.race([
        queue.add('generate', { jobId }, generationJobOptions(jobId)),
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error('enqueue timeout'));
          }, ENQUEUE_TIMEOUT_MS),
        ),
      ]);
      return true;
    } catch (error) {
      this.logger.warn({
        msg: 'enqueue_deferred',
        jobId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return false;
    }
  }

  /**
   * "Check again" for a running video job (M5 design §5.3): runs its pending status read now, or
   * adds one when none is waiting. Throws when Redis is unavailable (the user may retry).
   */
  async pollNow(jobId: string, pollCount: number): Promise<void> {
    const queue = this.getQueue(VIDEO_GENERATION_QUEUE);
    const options = videoPollOptions(jobId, pollCount, 0);
    const existing = await queue.getJob(options.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'delayed') {
        await existing.promote();
        return;
      }
      if (state !== 'completed' && state !== 'failed') return; // waiting or running already
      await existing.remove();
    }
    await queue.add(VIDEO_POLL_JOB_NAME, { jobId }, options);
  }

  /**
   * Waiting, active, delayed and failed counts of every queue (operations page, M7 §8), or null
   * when Redis does not answer within the enqueue timeout.
   */
  async depths(): Promise<
    { queue: string; waiting: number; active: number; delayed: number; failed: number }[] | null
  > {
    const names = [
      GENERATION_QUEUE,
      IMAGE_GENERATION_QUEUE,
      VIDEO_GENERATION_QUEUE,
      AUDIO_GENERATION_QUEUE,
      RENDER_QUEUE,
      GENERATION_DLQ,
    ];
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.all(
          names.map(async (name) => {
            const c = await this.getQueue(name).getJobCounts(
              'waiting',
              'active',
              'delayed',
              'failed',
              'completed',
            );
            // Dead-letter entries are stored as completed jobs of the DLQ.
            const failed =
              name === GENERATION_DLQ
                ? (c['completed'] ?? 0) + (c['waiting'] ?? 0)
                : (c['failed'] ?? 0);
            return {
              queue: name,
              waiting: name === GENERATION_DLQ ? 0 : (c['waiting'] ?? 0),
              active: c['active'] ?? 0,
              delayed: c['delayed'] ?? 0,
              failed,
            };
          }),
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
          }, ENQUEUE_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.logger.warn({
        msg: 'queue_depths_unavailable',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private getQueue(name: string): Queue<GenerationJobPayload> {
    if (!this.connection) {
      this.connection = new Redis(this.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: true,
        connectTimeout: 2_000,
        retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
      });
      this.connection.on('error', () => undefined);
    }
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue<GenerationJobPayload>(name, {
        connection: this.connection,
        prefix: this.env.QUEUE_PREFIX,
      });
      queue.on('error', () => undefined);
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
    this.connection?.disconnect();
  }
}
