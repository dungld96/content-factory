import { HttpStatus, Injectable } from '@nestjs/common';

import {
  imageJobInputSchema,
  DOUBLE_CHARGE_CODES,
  renderJobInputSchema,
  renderManifestSchema,
  renderSettingsSchema,
  storyboardJobInputSchema,
  ttsJobInputSchema,
  videoJobInputSchema,
} from '@acf/content-domain';
import { ApiErrorCode, type ResumeRunRequest, type ResumeRunResponseDto } from '@acf/contracts';
import type { GenerationJob } from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { notFound } from '../common/domain-errors.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { GenerationService } from './generation.service.js';
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
    if (newRunId === null) return { resumedFromRunId: run.id, run: null, skipped };
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
