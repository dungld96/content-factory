import { nextContentStatus, type ContentStatus, type PipelineEvent } from '@acf/content-domain';
import type {
  GenerationJob,
  GenerationJobStatus,
  Prisma,
  PrismaClient,
  TransactionClient,
} from '@acf/database';

/**
 * Every job state transition the worker makes, each in one transaction with its `job_events` row
 * (CLAUDE.md §7: record state transitions). Guarded updates (`WHERE status = …`) make each
 * transition happen at most once, also when a job is delivered twice or canceled concurrently.
 */
export class JobStore {
  constructor(private readonly prisma: PrismaClient) {}

  load(jobId: string): Promise<GenerationJob | null> {
    return this.prisma.generationJob.findUnique({ where: { id: jobId } });
  }

  /**
   * Starts an attempt: `queued → running`, or `running → running` when BullMQ redelivers a
   * stalled job (the previous worker died mid-attempt). Returns null when the job must not run
   * (canceled, finished, or attempts exhausted).
   */
  async startAttempt(jobId: string): Promise<GenerationJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.generationJob.findUnique({ where: { id: jobId } });
      if (!job || (job.status !== 'queued' && job.status !== 'running')) return null;
      if (job.attempt >= job.maxAttempts) return null;
      const stalled = job.status === 'running';
      const { count } = await tx.generationJob.updateMany({
        where: { id: jobId, status: job.status, attempt: job.attempt },
        data: {
          status: 'running',
          attempt: job.attempt + 1,
          ...(job.startedAt ? {} : { startedAt: new Date() }),
        },
      });
      if (count !== 1) return null; // someone else moved it
      await this.event(tx, job, job.status, 'running', job.attempt + 1, {
        type: stalled ? 'stalled_recovered' : 'attempt_started',
      });
      if (!stalled && job.attempt === 0) {
        await tx.productionRun.updateMany({
          where: { id: job.productionRunId, status: 'queued' },
          data: { status: 'running' },
        });
      }
      return { ...job, status: 'running', attempt: job.attempt + 1 };
    });
  }

  async recordPrompt(jobId: string, snapshot: string): Promise<void> {
    await this.prisma.generationJob.updateMany({
      where: { id: jobId, promptSnapshot: null },
      data: { promptSnapshot: snapshot },
    });
  }

  /** `running → queued`, waiting for BullMQ's next (backed-off) delivery. */
  async scheduleRetry(job: GenerationJob, errorCode: string, delayMs: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.generationJob.updateMany({
        where: { id: job.id, status: 'running', attempt: job.attempt },
        data: { status: 'queued', errorCode, errorMessage: null },
      });
      if (count === 1) {
        await this.event(tx, job, 'running', 'queued', job.attempt, {
          type: 'retry_scheduled',
          errorCode,
          delayMs,
        });
      }
    });
  }

  /**
   * Final failure: `queued|running → failed`, run failed, content status restored. Returns false
   * when the job had already ended (e.g. canceled meanwhile).
   */
  async fail(
    job: GenerationJob,
    errorCode: string,
    errorMessage: string,
    detail: Prisma.InputJsonObject = {},
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.generationJob.findUnique({ where: { id: job.id } });
      if (!current || (current.status !== 'running' && current.status !== 'queued')) return false;
      await tx.generationJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          activeKey: null,
          completedAt: new Date(),
          errorCode,
          errorMessage: errorMessage.slice(0, 500),
        },
      });
      await this.event(tx, current, current.status, 'failed', current.attempt, {
        type: 'failed',
        errorCode,
        ...detail,
      });
      if (current.kind === 'image_generation') {
        await this.settleImageWork(tx, current);
      } else {
        await this.endRun(tx, current.productionRunId, 'failed');
        await this.restoreContent(tx, current);
      }
      return true;
    });
  }

  /**
   * An image job succeeds inside the caller's transaction (which inserted its assets). Returns
   * false when the job is no longer running (canceled meanwhile): the caller rolls back.
   */
  async succeedImageIn(
    tx: TransactionClient,
    job: GenerationJob,
    assetIds: readonly string[],
  ): Promise<boolean> {
    const { count } = await tx.generationJob.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'succeeded',
        activeKey: null,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    if (count !== 1) return false;
    await this.event(tx, job, 'running', 'succeeded', job.attempt, {
      type: 'succeeded',
      assetIds: [...assetIds],
    });
    await this.settleImageWork(tx, job);
    return true;
  }

  /**
   * After an image job ended (M4 design §5.5): its run ends once none of the run's jobs is
   * active (succeeded if any job succeeded), and the content item leaves `generating_assets`
   * once none of its image jobs is active. The content item is locked first, so two scene jobs
   * ending together serialize here and the second one sees the first one's committed outcome.
   */
  async settleImageWork(tx: TransactionClient, job: GenerationJob): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM content_items WHERE id = ${job.contentItemId}::uuid FOR NO KEY UPDATE`;
    const runActive = await tx.generationJob.count({
      where: { productionRunId: job.productionRunId, status: { in: ['queued', 'running'] } },
    });
    if (runActive === 0) {
      const anySucceeded = await tx.generationJob.count({
        where: { productionRunId: job.productionRunId, status: 'succeeded' },
      });
      await this.endRun(tx, job.productionRunId, anySucceeded > 0 ? 'succeeded' : 'failed');
    }
    const itemActive = await tx.generationJob.count({
      where: {
        contentItemId: job.contentItemId,
        kind: 'image_generation',
        status: { in: ['queued', 'running'] },
      },
    });
    if (itemActive > 0) return;
    const candidates = await tx.asset.count({
      where: {
        contentItemId: job.contentItemId,
        sourceType: 'generated',
        assetType: 'image',
        archivedAt: null,
      },
    });
    await this.transitionContent(tx, job.contentItemId, {
      type: 'image_jobs_settled',
      hasCandidates: candidates > 0,
      previous: job.previousContentStatus,
    });
  }

  /**
   * Succeeds inside the caller's transaction (which also inserted the version). Returns false
   * when the job is no longer running (canceled during the LLM call): the caller rolls back, so
   * the result is discarded (M3 design §8.5).
   */
  async succeedIn(
    tx: TransactionClient,
    job: GenerationJob,
    result: { scriptVersionId?: string; storyboardVersionId?: string },
    event: PipelineEvent,
  ): Promise<boolean> {
    const { count } = await tx.generationJob.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'succeeded',
        activeKey: null,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        resultScriptVersionId: result.scriptVersionId ?? null,
        resultStoryboardVersionId: result.storyboardVersionId ?? null,
      },
    });
    if (count !== 1) return false;
    await this.event(tx, job, 'running', 'succeeded', job.attempt, {
      type: 'succeeded',
      ...result,
    });
    await this.endRun(tx, job.productionRunId, 'succeeded');
    await this.transitionContent(tx, job.contentItemId, event);
    return true;
  }

  /** Records that a canceled job's result was discarded (its cost is in the ledger). */
  async noteDiscarded(job: GenerationJob): Promise<void> {
    await this.prisma.jobEvent.create({
      data: {
        projectId: job.projectId,
        jobId: job.id,
        fromStatus: 'canceled',
        toStatus: 'canceled',
        attempt: job.attempt,
        detail: { type: 'result_discarded' },
      },
    });
  }

  private async endRun(
    tx: TransactionClient,
    runId: string,
    status: 'succeeded' | 'failed',
  ): Promise<void> {
    await tx.productionRun.updateMany({
      where: { id: runId, status: { in: ['queued', 'running'] } },
      data: { status, completedAt: new Date() },
    });
  }

  private async restoreContent(tx: TransactionClient, job: GenerationJob): Promise<void> {
    await this.transitionContent(tx, job.contentItemId, {
      type: 'job_ended_without_result',
      previous: job.previousContentStatus,
    });
  }

  /**
   * Applies a pipeline transition under a parent lock. If the item moved on meanwhile (e.g. the
   * editor started another stage), the status is left unchanged: the job's outcome is still
   * recorded on the job itself.
   */
  private async transitionContent(
    tx: TransactionClient,
    contentItemId: string,
    event: PipelineEvent,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ status: ContentStatus }[]>`
      SELECT status::text AS status FROM content_items WHERE id = ${contentItemId}::uuid FOR NO KEY UPDATE`;
    const from = rows[0]?.status;
    if (!from) return;
    let to: ContentStatus;
    try {
      to = nextContentStatus(from, event);
    } catch {
      return;
    }
    if (to !== from) {
      await tx.contentItem.update({ where: { id: contentItemId }, data: { status: to } });
    }
  }

  private async event(
    tx: TransactionClient,
    job: Pick<GenerationJob, 'id' | 'projectId'>,
    from: GenerationJobStatus | null,
    to: GenerationJobStatus,
    attempt: number,
    detail: Prisma.InputJsonObject,
  ): Promise<void> {
    await tx.jobEvent.create({
      data: {
        projectId: job.projectId,
        jobId: job.id,
        fromStatus: from,
        toStatus: to,
        attempt,
        detail,
      },
    });
  }
}
