import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import {
  activePrices,
  Capability,
  filterCandidates,
  LlmParameter,
  videoConstraintsSchema,
  type PriceComponent,
  type QualityTier,
} from '@acf/ai-core';
import { ModelCatalog, resolveReservation, VideoService } from '@acf/ai-runtime';
import {
  activeJobKey,
  executionKey,
  nextContentStatus,
  scriptJobInputSchema,
  storyboardJobInputSchema,
  validateBrief,
  type BriefValidation,
  type ContentStatus,
  type ScriptJobInput,
  type StoryboardJobInput,
  type TextJobKind,
  estimateTextJob,
  narrationWordsPerSecond,
} from '@acf/content-domain';
import {
  ApiErrorCode,
  contentBriefSchema,
  type BriefValidationDto,
  type GenerateRequest,
  type GenerateResponseDto,
  type GenerationJobDetailDto,
  type GenerationJobDto,
  type ProductionRunDto,
} from '@acf/contracts';
import {
  databaseErrorInfo,
  PostgresSqlState,
  type ContentItem,
  type GenerationJob,
  type GenerationJobKind,
  type TransactionClient,
} from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { BudgetsService } from '../budgets/budgets.service.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound } from '../common/domain-errors.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { GenerationQueue } from './generation.queue.js';
import { costSummary, toEventDto, toJobDto } from './mappers.js';

const RATIO: Readonly<Record<string, string>> = {
  ratio_9_16: '9:16',
  ratio_16_9: '16:9',
  ratio_1_1: '1:1',
};

/** Scene-scoped media job kinds (settled together; M4/M5). */
const SCENE_KIND_LIST: GenerationJobKind[] = [
  'image_generation',
  'video_generation',
  'tts_generation',
];
const SCENE_KINDS: ReadonlySet<string> = new Set(SCENE_KIND_LIST);

/** Parameters every generation sends (strict structured output, M3 design §5.3). */
const REQUIRED_PARAMETERS = new Set<string>([
  LlmParameter.MAX_TOKENS,
  LlmParameter.RESPONSE_FORMAT,
  LlmParameter.STRUCTURED_OUTPUTS,
]);
const TEMPLATE: Readonly<Record<TextJobKind, string>> = {
  script_generation: 'script.v1',
  storyboard_generation: 'storyboard.v2',
};
const DEFAULT_TIER: QualityTier = 'economy';

interface ResolvedBrief {
  readonly validation: BriefValidation;
  readonly characterVersionId: string | null;
  readonly environmentVersionId: string | null;
}

/**
 * Generation commands and queries (M3 design §7.1, §8.5, §10). Job intent, run, event and content
 * status are written in one transaction; the enqueue happens after commit and is best effort.
 */
@Injectable()
export class GenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly catalog: ModelCatalog,
    private readonly queue: GenerationQueue,
    private readonly videos: VideoService,
    private readonly budgets: BudgetsService,
  ) {}

  async validateBrief(actor: Actor, contentId: string): Promise<BriefValidationDto> {
    const item = await this.loadItem(contentId);
    await this.access.require(actor, item.projectId, 'viewer');
    const { validation } = await this.resolveBrief(item);
    return {
      valid: validation.errors.length === 0,
      errors: [...validation.errors],
      warnings: [...validation.warnings],
      flags: [...validation.flags],
    };
  }

  async generateScript(
    actor: Actor,
    contentId: string,
    request: GenerateRequest,
    clientKey: string | undefined,
  ): Promise<GenerateResponseDto> {
    const item = await this.loadItem(contentId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    if (item.archivedAt) throw archived('content item');
    const brief = await this.resolveBrief(item);
    if (brief.validation.errors.length > 0) {
      await this.markNeedsInput(item.id);
      throw new ApiError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ApiErrorCode.BriefInvalid,
        message: 'The brief has errors that block generation.',
        details: brief.validation.errors.map((e) => ({ path: e.path, message: e.message })),
      });
    }
    const model = await this.resolveModel('script_generation', request.modelKey);
    const b = brief.validation.normalized;
    // Parsed with the worker's schema so a contract mismatch fails here, not in the worker.
    const input: ScriptJobInput = scriptJobInputSchema.parse({
      brief: {
        topic: b.topic,
        audience: b.audience,
        objective: b.objective,
        tone: b.tone,
        callToAction: b.callToAction,
        notes: b.notes,
        sourceUrls: [...b.sourceUrls],
      },
      targetDurationSeconds: item.targetDurationSeconds,
      language: item.language,
      aspectRatio: RATIO[item.aspectRatio] ?? '9:16',
      claimFlags: [...brief.validation.flags],
      characterVersionId: brief.characterVersionId,
      environmentVersionId: brief.environmentVersionId,
      qualityTier: DEFAULT_TIER,
    });
    const inputVersionIds = [brief.characterVersionId, brief.environmentVersionId].filter(
      (x): x is string => x !== null,
    );
    return this.createJob(
      actor,
      item,
      'script_generation',
      input,
      inputVersionIds,
      model,
      request,
      clientKey,
    );
  }

  async generateStoryboard(
    actor: Actor,
    scriptVersionId: string,
    request: GenerateRequest,
    clientKey: string | undefined,
  ): Promise<GenerateResponseDto> {
    const script = await this.prisma.client.scriptVersion.findUnique({
      where: { id: scriptVersionId },
    });
    if (!script) throw notFound('script version');
    const item = await this.loadItem(script.contentItemId);
    await this.access.require(actor, item.projectId, 'editor', { mutation: true });
    if (item.archivedAt) throw archived('content item');
    if (item.approvedScriptVersionId !== script.id) {
      throw new ApiError({
        status: HttpStatus.CONFLICT,
        code: ApiErrorCode.ScriptNotApproved,
        message: 'Storyboards are generated only from the approved script.',
      });
    }
    const brief = await this.resolveBrief(item);
    if (brief.validation.errors.length > 0) {
      throw new ApiError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ApiErrorCode.BriefInvalid,
        message: 'The brief has errors that block generation.',
        details: brief.validation.errors.map((e) => ({ path: e.path, message: e.message })),
      });
    }
    const model = await this.resolveModel('storyboard_generation', request.modelKey);
    const input: StoryboardJobInput = storyboardJobInputSchema.parse({
      scriptVersionId: script.id,
      targetDurationSeconds: item.targetDurationSeconds,
      language: item.language,
      aspectRatio: RATIO[item.aspectRatio] ?? '9:16',
      characterVersionIds: brief.characterVersionId ? [brief.characterVersionId] : [],
      environmentVersionIds: brief.environmentVersionId ? [brief.environmentVersionId] : [],
      qualityTier: DEFAULT_TIER,
      ...(await this.productionConstraints(item)),
    });
    const inputVersionIds = [
      script.id,
      ...input.characterVersionIds,
      ...input.environmentVersionIds,
    ];
    return this.createJob(
      actor,
      item,
      'storyboard_generation',
      input,
      inputVersionIds,
      model,
      request,
      clientKey,
    );
  }

  async getJob(actor: Actor, jobId: string): Promise<GenerationJobDetailDto> {
    const job = await this.prisma.client.generationJob.findUnique({
      where: { id: jobId },
      include: { model: true, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!job) throw notFound('job');
    await this.access.require(actor, job.projectId, 'viewer');
    const [dto] = await this.jobDtos([job]);
    if (!dto) throw notFound('job');
    return { ...dto, events: job.events.map(toEventDto) };
  }

  async getRun(actor: Actor, runId: string): Promise<ProductionRunDto> {
    const run = await this.prisma.client.productionRun.findUnique({
      where: { id: runId },
      include: { jobs: { include: { model: true }, orderBy: { queuedAt: 'asc' } } },
    });
    if (!run) throw notFound('production run');
    await this.access.require(actor, run.projectId, 'viewer');
    const jobs = await this.jobDtos(run.jobs);
    const costs = await this.prisma.client.aiInvocation.findMany({
      where: { generationJobId: { in: run.jobs.map((j) => j.id) } },
      select: { costStatus: true, reportedCost: true, estimatedCost: true },
    });
    return {
      id: run.id,
      contentItemId: run.contentItemId,
      status: run.status,
      jobs,
      cost: costSummary(costs),
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      resumedFromRunId: run.resumedFromRunId,
    };
  }

  /**
   * Cancels a run's queued/running jobs (M3 design §8.5). A running job's current LLM call
   * finishes; the worker then discards its result (its cost stays recorded).
   */
  async cancelRun(actor: Actor, runId: string): Promise<ProductionRunDto> {
    const run = await this.prisma.client.productionRun.findUnique({ where: { id: runId } });
    if (!run) throw notFound('production run');
    await this.access.require(actor, run.projectId, 'editor', { mutation: true });
    const submitted: string[] = [];
    const canceled = await this.prisma.client.$transaction(async (tx) => {
      await lockContent(tx, run.contentItemId);
      const active = await tx.generationJob.findMany({
        where: { productionRunId: run.id, status: { in: ['queued', 'running'] } },
      });
      let count = 0;
      for (const job of active) {
        const { count: changed } = await tx.generationJob.updateMany({
          where: { id: job.id, status: job.status },
          data: { status: 'canceled', activeKey: null, completedAt: new Date() },
        });
        if (changed !== 1) continue;
        count += 1;
        const providerMayCharge = job.kind === 'video_generation' && job.invocationId !== null;
        if (providerMayCharge && job.invocationId) submitted.push(job.invocationId);
        // A submitted video may still be charged: its reservation keeps counting (held). Any
        // other call still in flight is counted from the ledger once it records its cost.
        await resolveReservation(tx, job.id, providerMayCharge ? 'held' : 'released');
        await tx.jobEvent.create({
          data: {
            projectId: job.projectId,
            jobId: job.id,
            fromStatus: job.status,
            toStatus: 'canceled',
            attempt: job.attempt,
            detail: { type: 'canceled', by: actor.userId },
          },
        });
        if (job.kind === 'render') {
          await transitionContent(tx, job.contentItemId, {
            type: 'render_ended_without_result',
            previous: job.previousContentStatus,
          });
        } else if (!SCENE_KINDS.has(job.kind)) {
          await transitionContent(tx, job.contentItemId, {
            type: 'job_ended_without_result',
            previous: job.previousContentStatus,
          });
        }
      }
      // Scene media jobs (M4 images, M5 clips and voice-overs): the item leaves
      // generating_assets once none of them is active.
      const imageJob = active.find((j) => SCENE_KINDS.has(j.kind));
      if (imageJob) {
        const stillActive = await tx.generationJob.count({
          where: {
            contentItemId: run.contentItemId,
            kind: { in: SCENE_KIND_LIST },
            status: { in: ['queued', 'running'] },
          },
        });
        if (stillActive === 0) {
          const candidates = await tx.asset.count({
            where: {
              contentItemId: run.contentItemId,
              sourceType: 'generated',
              assetType: { in: ['image', 'video', 'audio'] },
              archivedAt: null,
            },
          });
          await transitionContent(tx, run.contentItemId, {
            type: 'image_jobs_settled',
            hasCandidates: candidates > 0,
            previous: imageJob.previousContentStatus,
          });
        }
      }
      if (count > 0) {
        await tx.productionRun.updateMany({
          where: { id: run.id, status: { in: ['queued', 'running'] } },
          data: { status: 'canceled', completedAt: new Date() },
        });
      }
      return count;
    });
    // A submitted video keeps running at the provider (no cancel endpoint) and may be charged:
    // its invocation ends as outcome_unknown, never as free (M5 design §5.3).
    for (const invocationId of submitted) {
      await this.videos
        .abandon(invocationId, 'CANCELED_BY_USER', 'canceled; the provider may still charge')
        .catch(() => undefined);
    }
    if (canceled === 0) {
      throw new ApiError({
        status: HttpStatus.CONFLICT,
        code: ApiErrorCode.NotCancelable,
        message: 'The run has no queued or running work.',
      });
    }
    return this.getRun(actor, runId);
  }

  // ------------------------------------------------------------------- internals

  private async createJob(
    actor: Actor,
    item: ContentItem,
    kind: TextJobKind,
    input: ScriptJobInput | StoryboardJobInput,
    inputVersionIds: readonly string[],
    model: { id: string; modelKey: string; prices: readonly PriceComponent[] },
    request: GenerateRequest,
    clientKey: string | undefined,
  ): Promise<GenerateResponseDto> {
    const key = executionKey({
      kind,
      contentItemId: item.id,
      brief: input,
      inputVersionIds,
      promptTemplateId: TEMPLATE[kind],
      modelId: model.id,
    });
    const idempotencyKey = clientKey
      ? `${item.id}:${kind}:${clientKey}`
      : `${item.id}:${kind}:${randomUUID()}`;

    // A retried HTTP request with the same client key returns the original job.
    if (clientKey) {
      const existing = await this.prisma.client.generationJob.findUnique({
        where: { idempotencyKey },
        include: { model: true },
      });
      if (existing) return this.response(existing, false);
    }
    // Identical inputs already produced a result: reuse it (no new cost; CLAUDE.md §2.9).
    if (!request.regenerate) {
      const done = await this.prisma.client.generationJob.findFirst({
        where: { contentItemId: item.id, kind, executionKey: key, status: 'succeeded' },
        orderBy: { completedAt: 'desc' },
        include: { model: true },
      });
      if (done) return this.response(done, true);
    }

    let job: GenerationJob & { model: { modelKey: string } };
    try {
      job = await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, item.id);
        let next: ContentStatus;
        try {
          next = nextContentStatus(status, {
            type: kind === 'script_generation' ? 'script_job_queued' : 'storyboard_job_queued',
          });
        } catch {
          const active = await tx.generationJob.findUnique({
            where: { activeKey: activeJobKey(item.id, kind) },
          });
          throw active ? inProgress() : invalidState(status);
        }
        const run = await tx.productionRun.create({
          data: { projectId: item.projectId, contentItemId: item.id, requestedById: actor.userId },
        });
        const created = await tx.generationJob.create({
          data: {
            projectId: item.projectId,
            contentItemId: item.id,
            productionRunId: run.id,
            kind,
            activeKey: activeJobKey(item.id, kind),
            idempotencyKey,
            executionKey: key,
            input: input,
            previousContentStatus: status,
            promptTemplateId: TEMPLATE[kind],
            modelId: model.id,
            requestedById: actor.userId,
          },
          include: { model: true },
        });
        await tx.jobEvent.create({
          data: {
            projectId: item.projectId,
            jobId: created.id,
            toStatus: 'queued',
            attempt: 0,
            detail: { type: 'created', regenerate: request.regenerate ?? false },
          },
        });
        await tx.contentItem.update({ where: { id: item.id }, data: { status: next } });
        const { estimate, calls } = estimateTextJob(kind, model.prices);
        await this.budgets.reserve(tx, {
          actorId: actor.userId,
          projectId: item.projectId,
          contentItemId: item.id,
          jobs: [{ jobId: created.id, estimate, calls }],
          acceptOverBudget: request.acceptOverBudget,
        });
        return created;
      });
    } catch (error) {
      if (databaseErrorInfo(error)?.sqlState === PostgresSqlState.UNIQUE_VIOLATION) {
        const info = databaseErrorInfo(error);
        if (info?.constraint?.includes('active_key')) throw inProgress();
        if (info?.constraint?.includes('idempotency_key') && clientKey) {
          const existing = await this.prisma.client.generationJob.findUniqueOrThrow({
            where: { idempotencyKey },
            include: { model: true },
          });
          return this.response(existing, false);
        }
      }
      throw error;
    }
    await this.queue.enqueue(job.id);
    return this.response(job, false);
  }

  private async response(
    job: GenerationJob & { model: { modelKey: string } },
    reused: boolean,
  ): Promise<GenerateResponseDto> {
    const [dto] = await this.jobDtos([job]);
    if (!dto) throw notFound('job');
    return { productionRunId: job.productionRunId, job: dto, reused };
  }

  private async jobDtos(
    jobs: readonly (GenerationJob & { model: { modelKey: string } })[],
  ): Promise<GenerationJobDto[]> {
    const rows = await this.prisma.client.aiInvocation.findMany({
      where: { generationJobId: { in: jobs.map((j) => j.id) } },
      select: { generationJobId: true, costStatus: true, reportedCost: true, estimatedCost: true },
    });
    return jobs.map((job) =>
      toJobDto(
        job,
        job.model.modelKey,
        costSummary(rows.filter((r) => r.generationJobId === job.id)),
      ),
    );
  }

  /** The model routed to the task (or the override), and only if routing would accept it. */
  private async resolveModel(
    kind: TextJobKind,
    modelKey: string | undefined,
  ): Promise<{ id: string; modelKey: string; prices: readonly PriceComponent[] }> {
    const key =
      modelKey ??
      (
        await this.prisma.client.aiTaskRoute.findUnique({
          where: { task: kind },
          include: { model: true },
        })
      )?.model.modelKey;
    if (key === undefined) throw noModelRoute(`no model is routed to ${kind}`);
    const rows = await this.catalog.candidates(Capability.LLM, key);
    const decision = filterCandidates(
      rows.map((r) => r.candidate),
      {
        capability: Capability.LLM,
        parameters: REQUIRED_PARAMETERS,
        minimumTier: DEFAULT_TIER,
        modelKey: key,
      },
    );
    const chosen = decision.eligible[0];
    if (!chosen) throw noModelRoute(decision.explanation.join('; ') || `${key} is not registered`);
    const row = rows.find((r) => r.candidate.modelId === chosen.modelId);
    return {
      id: chosen.modelId,
      modelKey: chosen.modelKey,
      prices: activePrices(row?.prices ?? [], new Date()),
    };
  }

  /**
   * What the storyboard must fit (M8.5 Q1): the routed video model's clip lengths and the narration
   * pace of the content's voice profile (its language and speed; else the content's language).
   */
  private async productionConstraints(
    item: ContentItem,
  ): Promise<{ clipDurations: number[] | null; wordsPerSecond: number }> {
    const route = await this.prisma.client.aiTaskRoute.findUnique({
      where: { task: 'video_generation' },
      include: { model: true },
    });
    const constraints = videoConstraintsSchema.safeParse(route?.model.mediaConstraints);
    const durations = constraints.success
      ? [...new Set(constraints.data.durations)].sort((a, b) => a - b)
      : null;
    const profile = item.voiceProfileId
      ? await this.prisma.client.voiceProfile.findUnique({ where: { id: item.voiceProfileId } })
      : null;
    return {
      clipDurations: durations && durations.length > 0 ? durations : null,
      wordsPerSecond: narrationWordsPerSecond(
        profile?.language ?? item.language,
        profile?.speed === null || profile?.speed === undefined ? 1 : Number(profile.speed),
      ),
    };
  }

  private async resolveBrief(item: ContentItem): Promise<ResolvedBrief> {
    const parsed = contentBriefSchema.safeParse(item.brief);
    const brief = parsed.success ? parsed.data : { topic: '' };
    const master = async (kind: 'character' | 'environment', id: string | undefined) => {
      if (!id) return undefined;
      const row =
        kind === 'character'
          ? await this.prisma.client.character.findFirst({
              where: { id, projectId: item.projectId, archivedAt: null },
            })
          : await this.prisma.client.environment.findFirst({
              where: { id, projectId: item.projectId, archivedAt: null },
            });
      return { id, masterVersionId: row?.masterVersionId ?? null };
    };
    const character = await master('character', brief.characterId);
    const environment = await master('environment', brief.environmentId);
    // R0: the effective target platform adds advisory warnings only (never errors, never part
    // of the normalized brief or the execution key).
    const platform = item.channelId
      ? ((
          await this.prisma.client.channel.findUnique({
            where: { id: item.channelId },
            select: { platform: true },
          })
        )?.platform ?? null)
      : item.targetPlatform;
    const validation = validateBrief({
      ...brief,
      platform,
      format: 'short_video',
      targetDurationSeconds: item.targetDurationSeconds,
      language: item.language,
      aspectRatio: RATIO[item.aspectRatio] ?? '9:16',
      ...(character
        ? { character: { id: character.id, hasApprovedMaster: character.masterVersionId !== null } }
        : {}),
      ...(environment
        ? {
            environment: {
              id: environment.id,
              hasApprovedMaster: environment.masterVersionId !== null,
            },
          }
        : {}),
    });
    return {
      validation,
      characterVersionId: character?.masterVersionId ?? null,
      environmentVersionId: environment?.masterVersionId ?? null,
    };
  }

  private async markNeedsInput(contentItemId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await lockContent(tx, contentItemId);
      await transitionContent(tx, contentItemId, { type: 'brief_invalid' });
    });
  }

  private async loadItem(contentId: string): Promise<ContentItem> {
    const item = await this.prisma.client.contentItem.findUnique({ where: { id: contentId } });
    if (!item) throw notFound('content item');
    return item;
  }
}

/** Locks the content item (parent) and returns its status. */
export async function lockContent(
  tx: TransactionClient,
  contentItemId: string,
): Promise<ContentStatus> {
  const rows = await tx.$queryRaw<{ status: ContentStatus }[]>`
    SELECT status::text AS status FROM content_items WHERE id = ${contentItemId}::uuid FOR NO KEY UPDATE`;
  const status = rows[0]?.status;
  if (!status) throw notFound('content item');
  return status;
}

/** Applies a pipeline transition if allowed; otherwise leaves the status as it is. */
export async function transitionContent(
  tx: TransactionClient,
  contentItemId: string,
  event: Parameters<typeof nextContentStatus>[1],
): Promise<void> {
  const rows = await tx.$queryRaw<{ status: ContentStatus }[]>`
    SELECT status::text AS status FROM content_items WHERE id = ${contentItemId}::uuid`;
  const from = rows[0]?.status;
  if (!from) return;
  try {
    const to = nextContentStatus(from, event);
    if (to !== from)
      await tx.contentItem.update({ where: { id: contentItemId }, data: { status: to } });
  } catch {
    // Not applicable in the current status.
  }
}

const inProgress = () =>
  new ApiError({
    status: HttpStatus.CONFLICT,
    code: ApiErrorCode.GenerationInProgress,
    message: 'A generation of this kind is already queued or running for this content item.',
  });
const invalidState = (status: string) =>
  new ApiError({
    status: HttpStatus.CONFLICT,
    code: ApiErrorCode.InvalidPipelineState,
    message: `This stage cannot start while the content item is ${status}.`,
  });
const noModelRoute = (why: string) =>
  new ApiError({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    code: ApiErrorCode.NoModelRoute,
    message: `No usable model for this task (${why}).`,
  });
