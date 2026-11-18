import type { PrismaClient } from '@acf/database';

import type { Logger } from './logger.js';
import { generationJobOptions, type Queues } from './queues.js';

export interface ReconcileResult {
  readonly enqueued: number;
  readonly requeued: number;
  readonly failed: number;
}

export interface ReconcilerOptions {
  /** A `queued` job younger than this may still be on its way to Redis. */
  readonly queuedGraceMs?: number;
  /** A `running` job not updated for this long, without a live BullMQ job, lost its worker. */
  readonly runningGraceMs?: number;
}

/**
 * Outbox equivalent (ADR-0013 §2): PostgreSQL is the source of truth, Redis only transport.
 * - `queued` jobs missing from Redis (enqueue failed, Redis lost data) are enqueued again;
 *   the BullMQ id is the DB id, so this is idempotent.
 * - `running` jobs whose BullMQ job is gone go back to `queued` for another attempt, or fail
 *   with `WORKER_LOST` when no attempt is left.
 */
export class Reconciler {
  private readonly queuedGraceMs: number;
  private readonly runningGraceMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly queues: Queues,
    private readonly logger: Logger,
    options: ReconcilerOptions = {},
  ) {
    this.queuedGraceMs = options.queuedGraceMs ?? 30_000;
    this.runningGraceMs = options.runningGraceMs ?? 120_000;
  }

  async run(now: Date = new Date()): Promise<ReconcileResult> {
    let enqueued = 0;
    let requeued = 0;
    let failed = 0;

    const queued = await this.prisma.generationJob.findMany({
      where: { status: 'queued', updatedAt: { lt: new Date(now.getTime() - this.queuedGraceMs) } },
      select: { id: true },
      take: 500,
    });
    for (const { id } of queued) {
      const state = await this.state(id);
      if (state === 'missing' || state === 'completed' || state === 'failed') {
        if (state !== 'missing') await this.queues.generation.remove(id);
        await this.queues.generation.add('generate', { jobId: id }, generationJobOptions(id));
        enqueued += 1;
      }
    }

    const running = await this.prisma.generationJob.findMany({
      where: {
        status: 'running',
        updatedAt: { lt: new Date(now.getTime() - this.runningGraceMs) },
      },
      take: 500,
    });
    for (const job of running) {
      const state = await this.state(job.id);
      if (
        state === 'active' ||
        state === 'waiting' ||
        state === 'delayed' ||
        state === 'prioritized'
      )
        continue;
      if (job.attempt < job.maxAttempts) {
        const moved = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.generationJob.updateMany({
            where: { id: job.id, status: 'running', attempt: job.attempt },
            data: { status: 'queued', errorCode: 'WORKER_LOST' },
          });
          if (count === 1) {
            await tx.jobEvent.create({
              data: {
                projectId: job.projectId,
                jobId: job.id,
                fromStatus: 'running',
                toStatus: 'queued',
                attempt: job.attempt,
                detail: { type: 'reconciled_worker_lost' },
              },
            });
          }
          return count === 1;
        });
        if (moved) {
          if (state !== 'missing') await this.queues.generation.remove(job.id);
          await this.queues.generation.add(
            'generate',
            { jobId: job.id },
            generationJobOptions(job.id),
          );
          requeued += 1;
        }
      } else {
        // The processor's final-failure path also restores the content status and copies to the
        // DLQ; reuse it by delivering the job once more: startAttempt refuses, process() fails it.
        if (state !== 'missing') await this.queues.generation.remove(job.id);
        await this.queues.generation.add(
          'generate',
          { jobId: job.id },
          generationJobOptions(job.id),
        );
        failed += 1;
      }
    }
    if (enqueued + requeued + failed > 0) {
      this.logger.log('warn', 'reconciled', { enqueued, requeued, failed });
    }
    return { enqueued, requeued, failed };
  }

  private async state(jobId: string): Promise<string> {
    const job = await this.queues.generation.getJob(jobId);
    if (!job) return 'missing';
    return job.getState();
  }
}
