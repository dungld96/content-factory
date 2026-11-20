import type { PrismaClient } from '@acf/database';

import type { Logger } from './logger.js';
import {
  generationJobOptions,
  queueOf,
  scheduleVideoPoll,
  videoPollId,
  type Queues,
} from './queues.js';

export interface ReconcileResult {
  readonly enqueued: number;
  readonly requeued: number;
  readonly failed: number;
  /** Video jobs whose next status read was missing and has been scheduled again (M5). */
  readonly pollsResumed: number;
}

const LIVE = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

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
 * - Video jobs whose submit started (M5 design §5.4) are never attempted again: with a provider
 *   job id, a missing poll is scheduled again; without one, the job is delivered once more and
 *   the processor fails it with `SUBMIT_OUTCOME_UNKNOWN` (never a second paid submission).
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
      select: { id: true, kind: true },
      take: 500,
    });
    for (const { id, kind } of queued) {
      const queue = queueOf(this.queues, kind);
      const state = await this.state(id, kind);
      if (state === 'missing' || state === 'completed' || state === 'failed') {
        if (state !== 'missing') await queue.remove(id);
        await queue.add('generate', { jobId: id }, generationJobOptions(id));
        enqueued += 1;
      }
    }

    const running = await this.prisma.generationJob.findMany({
      where: {
        status: 'running',
        updatedAt: { lt: new Date(now.getTime() - this.runningGraceMs) },
        NOT: { kind: 'video_generation', submittedAt: { not: null } },
      },
      take: 500,
    });
    for (const job of running) {
      const queue = queueOf(this.queues, job.kind);
      const state = await this.state(job.id, job.kind);
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
          if (state !== 'missing') await queue.remove(job.id);
          await queue.add('generate', { jobId: job.id }, generationJobOptions(job.id));
          requeued += 1;
        }
      } else {
        // The processor's final-failure path also restores the content status and copies to the
        // DLQ; reuse it by delivering the job once more: startAttempt refuses, process() fails it.
        if (state !== 'missing') await queue.remove(job.id);
        await queue.add('generate', { jobId: job.id }, generationJobOptions(job.id));
        failed += 1;
      }
    }
    const pollsResumed = await this.videos(now);
    if (enqueued + requeued + failed + pollsResumed > 0) {
      // Alert name (M7 design §8): the reconciler had to repair queue state.
      this.logger.log('warn', 'reconciler_requeued', { enqueued, requeued, failed, pollsResumed });
    }
    return { enqueued, requeued, failed, pollsResumed };
  }

  /** Running video jobs past their submit (M5 design §5.4). */
  private async videos(now: Date): Promise<number> {
    const stale = new Date(now.getTime() - this.runningGraceMs);
    const jobs = await this.prisma.generationJob.findMany({
      where: {
        kind: 'video_generation',
        status: 'running',
        submittedAt: { not: null },
        updatedAt: { lt: stale },
        OR: [{ nextPollAt: null }, { nextPollAt: { lt: stale } }],
      },
      select: { id: true, providerJobId: true, pollCount: true },
      take: 500,
    });
    let resumed = 0;
    for (const job of jobs) {
      if (job.providerJobId) {
        const poll = await this.queues.videos.getJob(videoPollId(job.id, job.pollCount));
        if (poll && LIVE.has(await poll.getState())) continue;
        await scheduleVideoPoll(this.queues, job.id, job.pollCount, 0);
        resumed += 1;
        continue;
      }
      // The submit call's worker stopped: deliver once more so the processor records the
      // unknown outcome (it never resubmits).
      const state = await this.state(job.id, 'video_generation');
      if (LIVE.has(state)) continue;
      if (state !== 'missing') await this.queues.videos.remove(job.id);
      await this.queues.videos.add('generate', { jobId: job.id }, generationJobOptions(job.id));
      resumed += 1;
    }
    return resumed;
  }

  private async state(jobId: string, kind: string): Promise<string> {
    const job = await queueOf(this.queues, kind).getJob(jobId);
    if (!job) return 'missing';
    return job.getState();
  }
}
