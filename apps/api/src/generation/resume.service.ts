import { HttpStatus, Injectable } from '@nestjs/common';

import {
  activeSceneJobKey,
  imageJobInputSchema,
  isFinishable,
  nextContentStatus,
  DOUBLE_CHARGE_CODES,
  renderJobInputSchema,
  renderManifestSchema,
  renderSettingsSchema,
  storyboardJobInputSchema,
  ttsJobInputSchema,
  videoJobInputSchema,
} from '@acf/content-domain';
import { ApiErrorCode, type ResumeRunRequest, type ResumeRunResponseDto } from '@acf/contracts';
import {
  databaseErrorInfo,
  PostgresSqlState,
  type GenerationJob,
  type Prisma,
} from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { notFound } from '../common/domain-errors.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { GenerationQueue } from './generation.queue.js';
import { GenerationService, lockContent } from './generation.service.js';
import { ImagesService } from './images.service.js';
import { RendersService } from './renders.service.js';
import { VideosService } from './videos.service.js';
import { VoiceoversService } from './voiceovers.service.js';

type Skip = ResumeRunResponseDto['skipped'][number];

/**
 * Resume of a production run (M7 design §6, B6): each failed or canceled job's stage is requested
 * again for the same scope through the same planning code as a normal request (budget checks,
 * reuse of succeeded results), in a new run linked to the resumed one. A run holds jobs of one
 * stage, so one request (one new run) covers it.
 */
@Injectable()
export class ResumeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly generation: GenerationService,
    private readonly images: ImagesService,
    private readonly videos: VideosService,
    private readonly voiceovers: VoiceoversService,
    private readonly renders: RendersService,
    private readonly queue: GenerationQueue,
  ) {}

  async resume(
    actor: Actor,
    runId: string,
    request: ResumeRunRequest,
  ): Promise<ResumeRunResponseDto> {
    const run = await this.prisma.client.productionRun.findUnique({
      where: { id: runId },
      include: { jobs: { orderBy: { queuedAt: 'asc' } } },
    });
    if (!run) throw notFound('production run');
    await this.access.require(actor, run.projectId, 'editor', { mutation: true });

    const ended = run.jobs.filter((j) => j.status === 'failed' || j.status === 'canceled');
    const skipped: Skip[] = [];
    const toResume: GenerationJob[] = [];
    const toFinish: GenerationJob[] = [];
    for (const job of ended) {
      const later = await this.prisma.client.generationJob.findFirst({
        where: {
          contentItemId: job.contentItemId,
          kind: job.kind,
          storyboardSceneId: job.storyboardSceneId,
          queuedAt: { gt: job.queuedAt },
          status: { in: ['queued', 'running', 'succeeded'] },
        },
        orderBy: { queuedAt: 'desc' },
      });
      const sceneId = job.storyboardSceneId;
      if (later) {
        skipped.push({
          jobId: job.id,
          sceneId,
          reason: later.status === 'succeeded' ? 'superseded' : 'in_progress',
        });
      } else if (isFinishable(job)) {
        toFinish.push(job);
        skipped.push({ jobId: job.id, sceneId, reason: 'finished_without_charge' });
      } else if (
        job.errorCode !== null &&
        DOUBLE_CHARGE_CODES.has(job.errorCode) &&
        !request.acceptPossibleDoubleCharge
      ) {
        skipped.push({ jobId: job.id, sceneId, reason: 'outcome_unknown' });
      } else {
        toResume.push(job);
      }
    }
    const finishRunId = toFinish.length > 0 ? await this.finish(actor, toFinish) : null;
    if (toResume.length === 0 && finishRunId !== null) {
      await this.link(finishRunId, run.id);
      return {
        resumedFromRunId: run.id,
        run: await this.generation.getRun(actor, finishRunId),
        skipped,
      };
    }
    if (toResume.length === 0) {
      throw new ApiError({
        status: HttpStatus.CONFLICT,
        code: ApiErrorCode.NothingToResume,
        message:
          ended.length === 0
            ? 'This run has no failed or canceled jobs.'
            : 'Every failed job of this run was already redone, is running again, or needs acceptPossibleDoubleCharge.',
        current: { skipped },
      });
    }

    const startedAt = new Date();
    const newRunId = await this.requestAgain(actor, toResume, request);
    if (finishRunId !== null) await this.link(finishRunId, run.id);
    if (newRunId === null) {
      return {
        resumedFromRunId: run.id,
        run: finishRunId ? await this.generation.getRun(actor, finishRunId) : null,
        skipped,
      };
    }
    // Link only a run created by this request (a reused render points at an older run).
    await this.prisma.client.productionRun.updateMany({
      where: {
        id: newRunId,
        resumedFromRunId: null,
        createdAt: { gte: startedAt },
        NOT: { id: run.id },
      },
      data: { resumedFromRunId: run.id },
    });
    return {
      resumedFromRunId: run.id,
      run: await this.generation.getRun(actor, newRunId),
      skipped,
    };
  }

  private async link(newRunId: string, resumedRunId: string): Promise<void> {
    await this.prisma.client.productionRun.updateMany({
      where: { id: newRunId, resumedFromRunId: null },
      data: { resumedFromRunId: resumedRunId },
    });
  }

  /**
   * P3d R3: one finish job per failed job whose paid output was delivered, in a new run. Same
   * kind, scene, input and model; no reservation (it never calls a provider). The idempotency key
   * `finish:{jobId}` makes a second Resume a 409 instead of a duplicate.
   */
  private async finish(actor: Actor, jobs: readonly GenerationJob[]): Promise<string> {
    const [first] = jobs;
    if (!first) throw new Error('no jobs to finish');
    let created: GenerationJob[];
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, first.contentItemId);
        let next: typeof status;
        try {
          next = nextContentStatus(status, { type: 'image_jobs_queued' });
        } catch {
          throw new ApiError({
            status: HttpStatus.CONFLICT,
            code: ApiErrorCode.InvalidPipelineState,
            message: `Scenes cannot be finished while the content item is ${status}.`,
          });
        }
        const newRun = await tx.productionRun.create({
          data: {
            projectId: first.projectId,
            contentItemId: first.contentItemId,
            requestedById: actor.userId,
          },
        });
        const rows: GenerationJob[] = [];
        for (const failed of jobs) {
          const kind = failed.kind === 'tts_generation' ? 'tts_generation' : 'video_generation';
          const row = await tx.generationJob.create({
            data: {
              projectId: failed.projectId,
              contentItemId: failed.contentItemId,
              productionRunId: newRun.id,
              kind,
              storyboardSceneId: failed.storyboardSceneId,
              activeKey: failed.storyboardSceneId
                ? activeSceneJobKey(failed.storyboardSceneId, kind)
                : null,
              idempotencyKey: `finish:${failed.id}`,
              executionKey: failed.executionKey,
              input: failed.input as Prisma.InputJsonObject,
              previousContentStatus: status,
              promptTemplateId: failed.promptTemplateId,
              modelId: failed.modelId,
              requestedById: actor.userId,
              recoverFromJobId: failed.id,
            },
          });
          await tx.jobEvent.create({
            data: {
              projectId: row.projectId,
              jobId: row.id,
              toStatus: 'queued',
              attempt: 0,
              detail: {
                type: 'created',
                sceneId: failed.storyboardSceneId,
                finishes: failed.id,
              },
            },
          });
          rows.push(row);
        }
        if (next !== status) {
          await tx.contentItem.update({
            where: { id: first.contentItemId },
            data: { status: next },
          });
        }
        return rows;
      });
    } catch (e) {
      if (databaseErrorInfo(e)?.sqlState === PostgresSqlState.UNIQUE_VIOLATION) {
        throw new ApiError({
          status: HttpStatus.CONFLICT,
          code: ApiErrorCode.GenerationInProgress,
          message: 'These scenes are already being finished.',
        });
      }
      throw e;
    }
    for (const job of created) await this.queue.enqueue(job.id, job.kind);
    return created[0]?.productionRunId ?? '';
  }

  /** Requests the jobs' stage again; returns the new (or reused) run, or null when none. */
  private async requestAgain(
    actor: Actor,
    jobs: readonly GenerationJob[],
    request: ResumeRunRequest,
  ): Promise<string | null> {
    const [first] = jobs;
    if (!first) return null;
    const sceneIds = jobs.flatMap((j) => (j.storyboardSceneId ? [j.storyboardSceneId] : []));
    const budget =
      request.acceptOverBudget === undefined ? {} : { acceptOverBudget: request.acceptOverBudget };
    const unknownCost =
      request.acceptUnknownCost === undefined
        ? {}
        : { acceptUnknownCost: request.acceptUnknownCost };
    switch (first.kind) {
      case 'script_generation':
        return (await this.generation.generateScript(actor, first.contentItemId, budget, undefined))
          .productionRunId;
      case 'storyboard_generation': {
        const input = storyboardJobInputSchema.parse(first.input);
        return (
          await this.generation.generateStoryboard(actor, input.scriptVersionId, budget, undefined)
        ).productionRunId;
      }
      case 'image_generation': {
        const input = imageJobInputSchema.parse(first.input);
        return (
          await this.images.generate(actor, input.storyboardVersionId, {
            sceneIds,
            count: input.count,
            ...(input.resolution ? { resolution: input.resolution } : {}),
            ...(input.seed === null ? {} : { seed: input.seed }),
            ...budget,
            ...unknownCost,
          })
        ).productionRunId;
      }
      case 'video_generation': {
        const input = videoJobInputSchema.parse(first.input);
        return (
          await this.videos.generate(actor, input.storyboardVersionId, {
            sceneIds,
            resolution: input.resolution,
            generateAudio: input.generateAudio,
            ...(input.seed === null ? {} : { seed: input.seed }),
            ...(request.confirmedEstimateUsd
              ? { confirmedEstimateUsd: request.confirmedEstimateUsd }
              : {}),
            ...budget,
            ...unknownCost,
          })
        ).productionRunId;
      }
      case 'tts_generation': {
        const input = ttsJobInputSchema.parse(first.input);
        return (
          await this.voiceovers.generate(actor, input.storyboardVersionId, {
            sceneIds,
            ...budget,
            ...unknownCost,
          })
        ).productionRunId;
      }
      case 'render': {
        const { renderId } = renderJobInputSchema.parse(first.input);
        const render = await this.prisma.client.render.findUniqueOrThrow({
          where: { id: renderId },
        });
        const settings = renderSettingsSchema.safeParse(render.settings);
        const manifest = renderManifestSchema.safeParse(render.manifest);
        const music = manifest.success ? manifest.data.music : null;
        const created = await this.renders.create(actor, first.contentItemId, {
          ...(settings.success ? { captions: { burnIn: settings.data.captions.burnIn } } : {}),
          ...(music ? { music: { assetId: music.assetId, volumeDb: music.volumeDb } } : {}),
        });
        return created.render.job.productionRunId;
      }
    }
  }
}
