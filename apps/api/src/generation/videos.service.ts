import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import {
  activePrices,
  Capability,
  billedVideoSeconds,
  chooseVideoDuration,
  estimateVideoCost,
  UsdAmount,
  type VideoConstraints,
  type VideoResolution,
} from '@acf/ai-core';
import {
  MediaConstraintError,
  ModelCatalog,
  RoutingError,
  VideoService,
  type MediaRoute,
} from '@acf/ai-runtime';
import type { ApiEnv } from '@acf/config';
import {
  ApiErrorCode,
  type GenerationJobDto,
  type StoryboardVideosDto,
  type VideoEstimateDto,
  type VideoGenerateResponseDto,
  type VideoGenerationRequest,
} from '@acf/contracts';
import {
  activeSceneJobKey,
  clipContentHash,
  DEFAULT_VIDEO_RESOLUTION,
  executionKey,
  missingGates,
  nextContentStatus,
  VIDEO_PROMPT_TEMPLATE_ID,
  type ContentStatus,
  type GateKey,
  type VideoJobInput,
  type VideoScene,
} from '@acf/content-domain';
import {
  databaseErrorInfo,
  PostgresSqlState,
  type GenerationJob,
  type StoryboardScene,
} from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound, referenceNotFound } from '../common/domain-errors.js';
import { toAssetDto } from '../assets/assets.service.js';
import { API_ENV } from '../config/api-config.module.js';
import { ObjectStoreService, storageFailure } from '../infrastructure/object-store.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { GenerationQueue } from './generation.queue.js';
import { lockContent } from './generation.service.js';
import { costSummary, toJobDto } from './mappers.js';

type Action = VideoEstimateDto['scenes'][number]['action'];

interface ScenePlan {
  readonly scene: StoryboardScene;
  readonly videoScene: VideoScene;
  readonly action: Action;
  /** Clip length sent to the provider (a supported duration ≥ the scene). */
  readonly requestedSeconds: number | null;
  /** Seconds billed: the requested length, or the model's minimum billed seconds if higher. */
  readonly billedSeconds: number | null;
  readonly keyframeAssetId: string | null;
  readonly clipHash: string | null;
  readonly executionKey: string | null;
  readonly estimate: UsdAmount | null;
  readonly reuseAssetId?: string;
}

interface Plan {
  readonly item: { id: string; projectId: string; status: ContentStatus };
  readonly storyboardId: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly resolution: VideoResolution;
  readonly aspectRatio: '9:16' | '1:1' | '16:9';
  readonly generateAudio: boolean;
  readonly scenes: readonly ScenePlan[];
}

const ASPECT: Readonly<Record<string, '9:16' | '1:1' | '16:9'>> = {
  ratio_9_16: '9:16',
  ratio_1_1: '1:1',
  ratio_16_9: '16:9',
};

/** A 1×1 PNG stands in for the keyframe when routing (only its presence is checked). */
const FRAME_PLACEHOLDER = { mimeType: 'image/png' as const, bytes: new Uint8Array([0]) };

const error = (status: number, code: string, message: string, current?: unknown) =>
  new ApiError({ status, code, message, ...(current === undefined ? {} : { current }) });

export const videoScene = (s: StoryboardScene): VideoScene => ({
  sceneNumber: s.sceneNumber,
  durationSeconds: Number(s.durationSeconds),
  videoPrompt: s.videoPrompt,
  cameraMovement: s.cameraMovement,
  characterAction: s.characterAction,
  visualDescription: s.visualDescription,
});

/**
 * Scene clips (M5 design §6). The API plans, prices, guards spend and records intent; the
 * worker submits once and polls. A clip starts from the scene's approved keyframe.
 */
@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly videos: VideoService,
    private readonly catalog: ModelCatalog,
    private readonly queue: GenerationQueue,
    private readonly storage: ObjectStoreService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async estimate(
    actor: Actor,
    storyboardId: string,
    request: VideoGenerationRequest,
  ): Promise<VideoEstimateDto> {
    return this.estimateDto(await this.plan(actor, storyboardId, request, 'viewer'));
  }

  async generate(
    actor: Actor,
    storyboardId: string,
    request: VideoGenerationRequest,
  ): Promise<VideoGenerateResponseDto> {
    const plan = await this.plan(actor, storyboardId, request, 'editor');
    const estimate = this.estimateDto(plan);
    const toGenerate = plan.scenes.filter((s) => s.action === 'generate');
    if (toGenerate.length > 0) {
      if (estimate.unknownCost && !request.acceptUnknownCost) {
        throw error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ApiErrorCode.UnknownCostNotAccepted,
          'The cost of these clips cannot be estimated. Resend with acceptUnknownCost: true to proceed.',
          estimate,
        );
      }
      this.assertConfirmed(estimate, request.confirmedEstimateUsd);
      if (
        estimate.totalEstimatedUsd !== null &&
        UsdAmount.parse(estimate.totalEstimatedUsd).compare(
          UsdAmount.parse(estimate.spendGuardUsd),
        ) > 0
      ) {
        throw error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ApiErrorCode.SpendGuard,
          `This request is estimated at $${estimate.totalEstimatedUsd}, above the $${estimate.spendGuardUsd} per-request limit. Generate fewer scenes at a time.`,
          estimate,
        );
      }
      await this.assertKeyframeFiles(plan.item.projectId, toGenerate);
    }

    let created: GenerationJob[];
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, plan.item.id);
        for (const s of plan.scenes.filter((p) => p.action === 'reuse_clip')) {
          const assetId = s.reuseAssetId ?? '';
          await tx.sceneClip.upsert({
            where: { storyboardSceneId: s.scene.id },
            create: {
              storyboardSceneId: s.scene.id,
              projectId: plan.item.projectId,
              assetId,
              selectedById: actor.userId,
              selectedAt: new Date(),
            },
            update: {},
          });
          await tx.sceneClipEvent.create({
            data: {
              projectId: plan.item.projectId,
              storyboardSceneId: s.scene.id,
              assetId,
              selectedById: actor.userId,
              reason: 'reused',
            },
          });
        }
        if (toGenerate.length === 0) return [];
        let next: ContentStatus;
        try {
          next = nextContentStatus(status, { type: 'image_jobs_queued' });
        } catch {
          throw error(
            HttpStatus.CONFLICT,
            ApiErrorCode.InvalidPipelineState,
            `Clips cannot be generated while the content item is ${status}.`,
          );
        }
        const run = await tx.productionRun.create({
          data: {
            projectId: plan.item.projectId,
            contentItemId: plan.item.id,
            requestedById: actor.userId,
          },
        });
        const jobs: GenerationJob[] = [];
        for (const s of toGenerate) {
          const input: VideoJobInput = {
            storyboardVersionId: plan.storyboardId,
            sceneId: s.scene.id,
            scene: s.videoScene,
            keyframeAssetId: s.keyframeAssetId ?? '',
            durationSeconds: s.requestedSeconds ?? 0,
            resolution: plan.resolution,
            aspectRatio: plan.aspectRatio,
            generateAudio: plan.generateAudio,
            seed: request.seed ?? null,
            clipHash: s.clipHash ?? '',
            qualityTier: 'economy',
          };
          const job = await tx.generationJob.create({
            data: {
              projectId: plan.item.projectId,
              contentItemId: plan.item.id,
              productionRunId: run.id,
              kind: 'video_generation',
              storyboardSceneId: s.scene.id,
              activeKey: activeSceneJobKey(s.scene.id, 'video_generation'),
              idempotencyKey: `${s.scene.id}:video_generation:${run.id}`,
              executionKey: s.executionKey ?? '',
              input,
              previousContentStatus: status,
              promptTemplateId: VIDEO_PROMPT_TEMPLATE_ID,
              modelId: plan.modelId,
              requestedById: actor.userId,
            },
          });
          await tx.jobEvent.create({
            data: {
              projectId: plan.item.projectId,
              jobId: job.id,
              toStatus: 'queued',
              attempt: 0,
              detail: { type: 'created', sceneId: s.scene.id },
            },
          });
          jobs.push(job);
        }
        if (next !== status) {
          await tx.contentItem.update({ where: { id: plan.item.id }, data: { status: next } });
        }
        return jobs;
      });
    } catch (e) {
      if (databaseErrorInfo(e)?.sqlState === PostgresSqlState.UNIQUE_VIOLATION) {
        throw error(
          HttpStatus.CONFLICT,
          ApiErrorCode.GenerationInProgress,
          'A video job is already queued or running for one of these scenes.',
        );
      }
      throw e;
    }
    for (const job of created) await this.queue.enqueue(job.id, 'video_generation');
    return {
      productionRunId: created[0]?.productionRunId ?? null,
      jobs: await this.jobDtos(created.map((j) => ({ ...j, model: { modelKey: plan.modelKey } }))),
      estimate,
    };
  }

  /** Per scene: keyframe, selected clip, candidates, jobs and provider progress. */
  async view(actor: Actor, storyboardId: string): Promise<StoryboardVideosDto> {
    const storyboard = await this.loadStoryboard(storyboardId);
    await this.access.require(actor, storyboard.projectId, 'viewer');
    const item = await this.prisma.client.contentItem.findUniqueOrThrow({
      where: { id: storyboard.contentItemId },
      select: { approvedStoryboardVersionId: true },
    });
    const sceneIds = storyboard.scenes.map((s) => s.id);
    const [keyframes, clips, generated, jobs] = await Promise.all([
      this.prisma.client.sceneKeyframe.findMany({
        where: { storyboardSceneId: { in: sceneIds } },
        include: { asset: true },
      }),
      this.prisma.client.sceneClip.findMany({
        where: { storyboardSceneId: { in: sceneIds } },
        include: { asset: true },
      }),
      this.prisma.client.asset.findMany({
        where: {
          contentItemId: storyboard.contentItemId,
          assetType: 'video',
          sourceType: 'generated',
          archivedAt: null,
        },
        include: { inputs: { where: { role: 'keyframe' }, select: { inputAssetId: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.client.generationJob.findMany({
        where: { storyboardSceneId: { in: sceneIds }, kind: 'video_generation' },
        include: { model: { select: { modelKey: true } } },
        orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const jobDtos = await this.jobDtos(jobs);
    const scenes = storyboard.scenes.map((scene) => {
      const keyframe = keyframes.find((k) => k.storyboardSceneId === scene.id);
      const candidates = generated.filter(
        (a) =>
          a.storyboardSceneId === scene.id ||
          (keyframe !== undefined && a.inputs.some((i) => i.inputAssetId === keyframe.assetId)),
      );
      const sceneJobs = jobs.filter((j) => j.storyboardSceneId === scene.id);
      const dtoOf = (job: GenerationJob | undefined) =>
        job ? (jobDtos.find((d) => d.id === job.id) ?? null) : null;
      const active = sceneJobs.find((j) => j.status === 'queued' || j.status === 'running');
      const progressJob = active ?? sceneJobs[0];
      const clip = clips.find((c) => c.storyboardSceneId === scene.id);
      return {
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        durationSeconds: Number(scene.durationSeconds),
        videoPrompt: scene.videoPrompt,
        keyframe: keyframe ? toAssetDto(keyframe.asset) : null,
        clip: clip ? toAssetDto(clip.asset) : null,
        candidates: candidates.map((a) => toAssetDto(a)),
        activeJob: dtoOf(active),
        lastJob: dtoOf(sceneJobs[0]),
        progress: progressJob
          ? {
              providerStatus: progressJob.providerStatus,
              pollCount: progressJob.pollCount,
              submittedAt: progressJob.submittedAt?.toISOString() ?? null,
              lastPolledAt: progressJob.lastPolledAt?.toISOString() ?? null,
              nextPollAt: progressJob.nextPollAt?.toISOString() ?? null,
            }
          : null,
      };
    });
    return {
      storyboardVersionId: storyboard.id,
      approved: item.approvedStoryboardVersionId === storyboard.id,
      keyframesComplete: scenes.length > 0 && scenes.every((s) => s.keyframe !== null),
      clipsComplete: scenes.length > 0 && scenes.every((s) => s.clip !== null),
      scenes,
    };
  }

  /** Selects an approved clip candidate of the scene (AC016 enforces approval and ownership). */
  async setClip(actor: Actor, sceneId: string, assetId: string): Promise<StoryboardVideosDto> {
    const scene = await this.prisma.client.storyboardScene.findUnique({
      where: { id: sceneId },
      select: { id: true, projectId: true, storyboardVersionId: true },
    });
    if (!scene) throw notFound('scene');
    await this.access.require(actor, scene.projectId, 'editor', { mutation: true });
    const view = await this.view(actor, scene.storyboardVersionId);
    const sceneView = view.scenes.find((s) => s.sceneId === sceneId);
    const candidate = sceneView?.candidates.find((c) => c.id === assetId);
    if (!candidate) {
      const exists = await this.prisma.client.asset.findFirst({
        where: { id: assetId, projectId: scene.projectId },
        select: { id: true },
      });
      if (!exists) throw referenceNotFound('asset');
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.ClipInvalid,
        "A clip must be a video generated for this scene or from the scene's keyframe.",
      );
    }
    await this.prisma.client.$transaction(async (tx) => {
      const now = new Date();
      await tx.sceneClip.upsert({
        where: { storyboardSceneId: sceneId },
        create: {
          storyboardSceneId: sceneId,
          projectId: scene.projectId,
          assetId,
          selectedById: actor.userId,
          selectedAt: now,
        },
        update: { assetId, selectedById: actor.userId, selectedAt: now },
      });
      await tx.sceneClipEvent.create({
        data: {
          projectId: scene.projectId,
          storyboardSceneId: sceneId,
          assetId,
          selectedById: actor.userId,
          reason: 'selected',
        },
      });
    });
    return this.view(actor, scene.storyboardVersionId);
  }

  /**
   * "Check again" (M5 design §5.3): an immediate status read of a running video job that the
   * provider accepted. Free; never a resubmission.
   */
  async recheck(actor: Actor, jobId: string): Promise<GenerationJobDto> {
    const job = await this.prisma.client.generationJob.findUnique({
      where: { id: jobId },
      include: { model: { select: { modelKey: true } } },
    });
    if (!job) throw notFound('generation job');
    await this.access.require(actor, job.projectId, 'editor', { mutation: true });
    if (job.kind !== 'video_generation' || job.status !== 'running' || !job.providerJobId) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.JobNotRecheckable,
        'Only a running video job that the provider accepted can be checked again.',
      );
    }
    await this.queue.pollNow(job.id, job.pollCount);
    const [dto] = await this.jobDtos([job]);
    if (!dto) throw notFound('generation job');
    return dto;
  }

  // ------------------------------------------------------------------- planning

  private async plan(
    actor: Actor,
    storyboardId: string,
    request: VideoGenerationRequest,
    role: 'viewer' | 'editor',
  ): Promise<Plan> {
    const storyboard = await this.loadStoryboard(storyboardId);
    await this.access.require(actor, storyboard.projectId, role, { mutation: role === 'editor' });
    const item = await this.prisma.client.contentItem.findUniqueOrThrow({
      where: { id: storyboard.contentItemId },
      select: {
        id: true,
        projectId: true,
        status: true,
        format: true,
        aspectRatio: true,
        archivedAt: true,
        approvedScriptVersionId: true,
        approvedStoryboardVersionId: true,
      },
    });
    if (item.archivedAt) throw archived('content item');
    const gates = new Set<GateKey>();
    if (item.approvedScriptVersionId) gates.add('script_approved');
    if (item.approvedStoryboardVersionId === storyboard.id) gates.add('storyboard_approved');
    if (missingGates(item.format, 'clips', gates).length > 0) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.StoryboardNotApproved,
        'Clips are generated only for the approved storyboard.',
      );
    }

    const route = await this.prisma.client.aiTaskRoute.findUnique({
      where: { task: 'video_generation' },
      include: { model: { select: { modelKey: true } } },
    });
    const modelKey = request.modelKey ?? route?.model.modelKey;
    if (modelKey === undefined) {
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.NoModelRoute,
        'No model is routed to video generation.',
      );
    }
    const aspectRatio = ASPECT[item.aspectRatio] ?? '9:16';
    const resolution = request.resolution ?? DEFAULT_VIDEO_RESOLUTION;
    const generateAudio = request.generateAudio ?? false;

    const selected = request.sceneIds
      ? request.sceneIds.map((id) => {
          const s = storyboard.scenes.find((scene) => scene.id === id);
          if (!s) throw referenceNotFound('scene');
          return s;
        })
      : storyboard.scenes;

    const constraints = await this.constraintsOf(modelKey);
    const durations = constraints.durations.filter((d) => d > 0);
    // Route once per billed duration: the constraints check covers every parameter.
    const routes = new Map<number, MediaRoute>();
    const routeFor = async (durationSeconds: number): Promise<MediaRoute> => {
      const known = routes.get(durationSeconds);
      if (known) return known;
      try {
        const routed = await this.videos.route(
          { qualityTier: 'economy' },
          {
            modelKey,
            durationSeconds,
            resolution,
            aspectRatio,
            generateAudio,
            ...(request.seed === undefined ? {} : { seed: request.seed }),
            firstFrame: FRAME_PLACEHOLDER,
          },
        );
        routes.set(durationSeconds, routed);
        return routed;
      } catch (e) {
        if (e instanceof RoutingError) {
          throw error(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.NoModelRoute, e.message);
        }
        if (e instanceof MediaConstraintError) {
          throw error(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.ModelLimits, e.message);
        }
        throw e;
      }
    };
    // The model must be routable even when no scene needs a clip (estimate shows the model).
    const base = await routeFor(durations[0] ?? 1);
    const modelId = base.row.candidate.modelId;
    const prices = activePrices(base.row.prices, new Date());

    const sceneIds = selected.map((s) => s.id);
    const [keyframes, clips, activeJobs] = await Promise.all([
      this.prisma.client.sceneKeyframe.findMany({ where: { storyboardSceneId: { in: sceneIds } } }),
      this.prisma.client.sceneClip.findMany({ where: { storyboardSceneId: { in: sceneIds } } }),
      this.prisma.client.generationJob.findMany({
        where: {
          storyboardSceneId: { in: sceneIds },
          kind: 'video_generation',
          status: { in: ['queued', 'running'] },
        },
        select: { storyboardSceneId: true },
      }),
    ]);

    const scenes: ScenePlan[] = [];
    for (const scene of selected) {
      const vs = videoScene(scene);
      const keyframeAssetId =
        keyframes.find((k) => k.storyboardSceneId === scene.id)?.assetId ?? null;
      const requestedSeconds = chooseVideoDuration(vs.durationSeconds, durations);
      const billedSeconds =
        requestedSeconds === null ? null : billedVideoSeconds(requestedSeconds, constraints);
      const skeleton = {
        scene,
        videoScene: vs,
        keyframeAssetId,
        requestedSeconds,
        billedSeconds,
        clipHash: null,
        executionKey: null,
        estimate: UsdAmount.ZERO,
      };
      const explicit = request.sceneIds?.includes(scene.id) ?? false;
      if (activeJobs.some((j) => j.storyboardSceneId === scene.id)) {
        scenes.push({ ...skeleton, action: 'skip_in_progress' });
        continue;
      }
      if (!keyframeAssetId) {
        scenes.push({ ...skeleton, action: 'skip_no_keyframe' });
        continue;
      }
      if (requestedSeconds === null || billedSeconds === null) {
        scenes.push({ ...skeleton, action: 'skip_exceeds_model_maximum' });
        continue;
      }
      await routeFor(requestedSeconds);
      const clipHash = clipContentHash({
        scene: vs,
        keyframeAssetId,
        modelId,
        durationSeconds: requestedSeconds,
        resolution,
        aspectRatio,
        generateAudio,
      });
      const key = executionKey({
        kind: 'video_generation',
        contentItemId: item.id,
        brief: { clipHash, seed: request.seed ?? null },
        inputVersionIds: [keyframeAssetId],
        promptTemplateId: VIDEO_PROMPT_TEMPLATE_ID,
        modelId,
      });
      const withKey = { ...skeleton, clipHash, executionKey: key };
      if (clips.some((c) => c.storyboardSceneId === scene.id) && !explicit) {
        scenes.push({ ...withKey, action: 'skip_has_clip' });
        continue;
      }
      if (!request.regenerate) {
        const reused = await this.reusableClip(item.id, clipHash);
        if (reused && !clips.some((c) => c.storyboardSceneId === scene.id)) {
          scenes.push({ ...withKey, action: 'reuse_clip', reuseAssetId: reused });
          continue;
        }
        if (
          await this.prisma.client.generationJob.findFirst({
            where: { contentItemId: item.id, executionKey: key, status: 'succeeded' },
            select: { id: true },
          })
        ) {
          scenes.push({ ...withKey, action: 'skip_existing_result' });
          continue;
        }
      }
      scenes.push({
        ...withKey,
        action: 'generate',
        estimate: estimateVideoCost({
          prices,
          usage: { seconds: billedSeconds, inputImages: 1, resolution, audio: generateAudio },
        }),
      });
    }
    return {
      item: { id: item.id, projectId: item.projectId, status: item.status },
      storyboardId: storyboard.id,
      modelId,
      modelKey: base.row.candidate.modelKey,
      resolution,
      aspectRatio,
      generateAudio,
      scenes,
    };
  }

  private async constraintsOf(modelKey: string): Promise<VideoConstraints> {
    const rows = await this.catalog.candidates(Capability.VIDEO_GENERATION, modelKey);
    const constraints = rows.find((r) => r.videoConstraints !== null)?.videoConstraints;
    if (!constraints) {
      if (rows.length === 0) {
        throw error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ApiErrorCode.NoModelRoute,
          `No video model ${modelKey} is registered.`,
        );
      }
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.ModelLimits,
        `The video model ${modelKey} has no recorded constraints (re-import it).`,
      );
    }
    return constraints;
  }

  /** An approved, selected clip of this content item with the same clip hash. */
  private async reusableClip(contentItemId: string, clipHash: string): Promise<string | undefined> {
    const rows = await this.prisma.client.$queryRaw<{ asset_id: string }[]>`
      SELECT c.asset_id FROM scene_clips c JOIN assets a ON a.id = c.asset_id
      WHERE a.content_item_id = ${contentItemId}::uuid AND a.approval_status = 'approved'
        AND a.archived_at IS NULL AND a.metadata ->> 'clipHash' = ${clipHash}
      ORDER BY c.selected_at DESC LIMIT 1`;
    return rows[0]?.asset_id;
  }

  /** The confirmed total must cover the current one (decision V10). */
  private assertConfirmed(estimate: VideoEstimateDto, confirmed: string | null | undefined): void {
    const current = estimate.totalEstimatedUsd;
    const ok =
      confirmed !== undefined &&
      (current === null
        ? confirmed === null
        : confirmed !== null && UsdAmount.parse(current).compare(UsdAmount.parse(confirmed)) <= 0);
    if (!ok) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.EstimateChanged,
        confirmed === undefined
          ? 'Confirm the estimate first: resend with confirmedEstimateUsd set to the total shown.'
          : 'The estimate changed since it was shown. Review it and confirm again.',
        estimate,
      );
    }
  }

  /** Every keyframe must have its file in storage before paid work is queued. */
  private async assertKeyframeFiles(
    projectId: string,
    scenes: readonly ScenePlan[],
  ): Promise<void> {
    const store = this.storage.require();
    const ids = [...new Set(scenes.map((s) => s.keyframeAssetId ?? ''))];
    const assets = await this.prisma.client.asset.findMany({
      where: { projectId, id: { in: ids } },
      select: { id: true, storageKey: true },
    });
    for (const id of ids) {
      const asset = assets.find((a) => a.id === id);
      let present = false;
      try {
        present = asset !== undefined && (await store.head(asset.storageKey)) !== null;
      } catch (e) {
        storageFailure(e);
      }
      if (!present) {
        throw error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ApiErrorCode.ReferenceFileMissing,
          `Keyframe ${id} has no stored file.`,
        );
      }
    }
  }

  private estimateDto(plan: Plan): VideoEstimateDto {
    const generating = plan.scenes.filter((s) => s.action === 'generate');
    const unknownCost = generating.some((s) => s.estimate === null);
    return {
      modelKey: plan.modelKey,
      resolution: plan.resolution,
      generateAudio: plan.generateAudio,
      scenes: plan.scenes.map((s) => ({
        sceneId: s.scene.id,
        sceneNumber: s.scene.sceneNumber,
        action: s.action,
        sceneSeconds: s.videoScene.durationSeconds,
        requestedSeconds: s.requestedSeconds,
        billedSeconds: s.billedSeconds,
        estimatedUsd:
          s.action !== 'generate' ? '0' : s.estimate === null ? null : s.estimate.toString(),
      })),
      totalEstimatedUsd: unknownCost
        ? null
        : UsdAmount.sum(generating.map((s) => s.estimate ?? UsdAmount.ZERO)).toString(),
      unknownCost,
      spendGuardUsd: UsdAmount.parse(this.env.VIDEO_MAX_ESTIMATED_USD_PER_REQUEST).toString(),
      providerRetainsInputs: true,
    };
  }

  private async loadStoryboard(storyboardId: string) {
    const storyboard = await this.prisma.client.storyboardVersion.findUnique({
      where: { id: storyboardId },
      include: { scenes: { orderBy: { sceneNumber: 'asc' } } },
    });
    if (!storyboard) throw notFound('storyboard');
    return storyboard;
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
}
