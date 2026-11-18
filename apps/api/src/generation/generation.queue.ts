import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { ApiEnv } from '@acf/config';
import { generationJobOptions, queueForKind, type GenerationJobPayload } from '@acf/content-domain';

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
