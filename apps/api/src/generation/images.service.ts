import { HttpStatus, Injectable } from '@nestjs/common';

import { activePrices, estimateImageCost, UsdAmount, type ImageResolution } from '@acf/ai-core';
import { ImageConstraintError, ImageService, RoutingError } from '@acf/ai-runtime';
import {
  ApiErrorCode,
  type AssetDto,
  type GenerationJobDto,
  type ImageEstimateDto,
  type ImageGenerateResponseDto,
  type ImageGenerationRequest,
  type StoryboardImagesDto,
} from '@acf/contracts';
import {
  activeImageJobKey,
  DEFAULT_IMAGE_RESOLUTION,
  executionKey,
  IMAGE_CANDIDATES,
  IMAGE_PROMPT_TEMPLATE_ID,
  missingGates,
  nextContentStatus,
  sceneContentHash,
  type ContentStatus,
  type GateKey,
  type ImageJobInput,
  type ImageScene,
  type ReferenceRole,
} from '@acf/content-domain';
import {
  databaseErrorInfo,
  PostgresSqlState,
  type Asset,
  type GenerationJob,
  type Prisma,
} from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound, referenceNotFound } from '../common/domain-errors.js';
import { toAssetDto } from '../assets/assets.service.js';
import { ObjectStoreService, storageFailure } from '../infrastructure/object-store.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { GenerationQueue } from './generation.queue.js';
import { lockContent } from './generation.service.js';
import { costSummary, toJobDto } from './mappers.js';

const SCENE_INCLUDE = {
  referenceAssets: true,
  characterVersion: { include: { character: { select: { name: true } } } },
  environmentVersion: { include: { environment: { select: { name: true } } } },
} as const satisfies Prisma.StoryboardSceneInclude;

type SceneRow = Prisma.StoryboardSceneGetPayload<{ include: typeof SCENE_INCLUDE }>;

interface ScenePlan {
  readonly scene: SceneRow;
  readonly imageScene: ImageScene;
  readonly references: readonly { assetId: string; role: ReferenceRole }[];
  readonly sceneHash: string;
  readonly action: ImageEstimateDto['scenes'][number]['action'];
  readonly estimate: UsdAmount | null;
  readonly executionKey: string;
  /** For `reuse_keyframe`: the asset to reuse. */
  readonly reuseAssetId?: string;
}

interface Plan {
  readonly item: { id: string; projectId: string; status: ContentStatus };
  readonly storyboardId: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly aspectRatio: '9:16' | '1:1' | '16:9';
  readonly resolution: ImageResolution | null;
  readonly count: number;
  readonly zeroDataRetention: boolean;
  readonly scenes: readonly ScenePlan[];
}

const imageScene = (s: SceneRow): ImageScene => ({
  sceneNumber: s.sceneNumber,
  shotType: s.shotType,
  cameraAngle: s.cameraAngle,
  visualDescription: s.visualDescription,
  imagePrompt: s.imagePrompt,
  negativePrompt: s.negativePrompt,
  characterVersionId: s.characterVersionId,
  environmentVersionId: s.environmentVersionId,
});

/** Character master first, then environment, then the scene's own references (deduplicated). */
function referencesOf(s: SceneRow): { assetId: string; role: ReferenceRole }[] {
  const out: { assetId: string; role: ReferenceRole }[] = [];
  const add = (assetId: string | null | undefined, role: ReferenceRole) => {
    if (assetId && !out.some((r) => r.assetId === assetId)) out.push({ assetId, role });
  };
  add(s.characterVersion?.primaryAssetId, 'character');
  add(s.environmentVersion?.primaryAssetId, 'environment');
  for (const link of s.referenceAssets) add(link.assetId, 'scene_reference');
  return out;
}

const error = (status: number, code: string, message: string, current?: unknown) =>
  new ApiError({ status, code, message, ...(current === undefined ? {} : { current }) });

/**
 * Image generation for storyboard scenes (M4 design §5–§7). The API plans, validates, prices
 * and records intent; the worker makes the calls. One job per scene; identical scenes reuse
 * earlier results (CLAUDE.md §2.9).
 */
@Injectable()
export class ImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly images: ImageService,
    private readonly queue: GenerationQueue,
    private readonly storage: ObjectStoreService,
  ) {}

  async estimate(
    actor: Actor,
    storyboardId: string,
    request: ImageGenerationRequest,
  ): Promise<ImageEstimateDto> {
    const plan = await this.plan(actor, storyboardId, request, 'viewer');
    return estimateDto(plan);
  }

  async generate(
    actor: Actor,
    storyboardId: string,
    request: ImageGenerationRequest,
  ): Promise<ImageGenerateResponseDto> {
    const plan = await this.plan(actor, storyboardId, request, 'editor');
    const estimate = estimateDto(plan);
    if (estimate.unknownCost && !request.acceptUnknownCost) {
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.UnknownCostNotAccepted,
        'The cost of these images cannot be estimated. Resend with acceptUnknownCost: true to proceed.',
        estimate,
      );
    }
    const toGenerate = plan.scenes.filter((s) => s.action === 'generate');
    if (toGenerate.length > 0) await this.assertReferenceFiles(plan.item.projectId, toGenerate);

    let created: GenerationJob[];
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, plan.item.id);
        for (const s of plan.scenes.filter((p) => p.action === 'reuse_keyframe')) {
          await tx.sceneKeyframe.upsert({
            where: { storyboardSceneId: s.scene.id },
            create: {
              storyboardSceneId: s.scene.id,
              projectId: plan.item.projectId,
              assetId: s.reuseAssetId ?? '',
              selectedById: actor.userId,
              selectedAt: new Date(),
            },
            update: {},
          });
          await tx.sceneKeyframeEvent.create({
            data: {
              projectId: plan.item.projectId,
              storyboardSceneId: s.scene.id,
              assetId: s.reuseAssetId ?? '',
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
            `Images cannot be generated while the content item is ${status}.`,
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
          const input: ImageJobInput = {
            storyboardVersionId: plan.storyboardId,
            sceneId: s.scene.id,
            scene: s.imageScene,
            characterName: s.scene.characterVersion?.character.name ?? null,
            environmentName: s.scene.environmentVersion?.environment.name ?? null,
            aspectRatio: plan.aspectRatio,
            resolution: plan.resolution as ImageJobInput['resolution'],
            count: plan.count,
            seed: request.seed ?? null,
            references: [...s.references],
            sceneHash: s.sceneHash,
            zeroDataRetention: plan.zeroDataRetention,
            qualityTier: 'economy',
          };
          const job = await tx.generationJob.create({
            data: {
              projectId: plan.item.projectId,
              contentItemId: plan.item.id,
              productionRunId: run.id,
              kind: 'image_generation',
              storyboardSceneId: s.scene.id,
              activeKey: activeImageJobKey(s.scene.id),
              idempotencyKey: `${s.scene.id}:image_generation:${run.id}`,
              executionKey: s.executionKey,
              input,
              previousContentStatus: status,
              promptTemplateId: IMAGE_PROMPT_TEMPLATE_ID,
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
          'An image job is already queued or running for one of these scenes.',
        );
      }
      throw e;
    }
    for (const job of created) await this.queue.enqueue(job.id, 'image_generation');
    return {
      productionRunId: created[0]?.productionRunId ?? null,
      jobs: await this.jobDtos(created.map((j) => ({ ...j, model: { modelKey: plan.modelKey } }))),
      estimate,
    };
  }

  /** Per scene: keyframe, candidates (incl. identical earlier scenes), active and last job. */
  async view(actor: Actor, storyboardId: string): Promise<StoryboardImagesDto> {
    const storyboard = await this.loadStoryboard(storyboardId);
    await this.access.require(actor, storyboard.projectId, 'viewer');
    const item = await this.prisma.client.contentItem.findUniqueOrThrow({
      where: { id: storyboard.contentItemId },
      select: { approvedStoryboardVersionId: true, aspectRatio: true },
    });
    const sceneIds = storyboard.scenes.map((s) => s.id);
    const [keyframes, generated, jobs] = await Promise.all([
      this.prisma.client.sceneKeyframe.findMany({
        where: { storyboardSceneId: { in: sceneIds } },
        include: { asset: true },
      }),
      this.prisma.client.asset.findMany({
        where: {
          contentItemId: storyboard.contentItemId,
          assetType: 'image',
          sourceType: 'generated',
          archivedAt: null,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.client.generationJob.findMany({
        where: { storyboardSceneId: { in: sceneIds } },
        include: { model: { select: { modelKey: true } } },
        orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const jobDtos = await this.jobDtos(jobs);
    const ratio = ASPECT[item.aspectRatio] ?? '9:16';
    const scenes = storyboard.scenes.map((scene) => {
      const hash = sceneContentHash({
        scene: imageScene(scene),
        aspectRatio: ratio,
        referenceAssetIds: referencesOf(scene).map((r) => r.assetId),
      });
      const candidates = generated.filter(
        (a) => a.storyboardSceneId === scene.id || sceneHashOf(a) === hash,
      );
      const sceneJobs = jobDtos.filter(
        (j) => jobs.find((r) => r.id === j.id)?.storyboardSceneId === scene.id,
      );
      const keyframe = keyframes.find((k) => k.storyboardSceneId === scene.id);
      return {
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        imagePrompt: scene.imagePrompt,
        keyframe: keyframe ? toAssetDto(keyframe.asset) : null,
        candidates: candidates.map(toAssetDto),
        activeJob: sceneJobs.find((j) => j.status === 'queued' || j.status === 'running') ?? null,
        lastJob: sceneJobs[0] ?? null,
      };
    });
    return {
      storyboardVersionId: storyboard.id,
      approved: item.approvedStoryboardVersionId === storyboard.id,
      keyframesComplete: scenes.length > 0 && scenes.every((s) => s.keyframe !== null),
      scenes,
    };
  }

  /** Selects an approved candidate as the scene's keyframe (AC015 enforces the rules). */
  async setKeyframe(actor: Actor, sceneId: string, assetId: string): Promise<StoryboardImagesDto> {
    const scene = await this.prisma.client.storyboardScene.findUnique({
      where: { id: sceneId },
      select: { id: true, projectId: true, storyboardVersionId: true },
    });
    if (!scene) throw notFound('scene');
    await this.access.require(actor, scene.projectId, 'editor', { mutation: true });
    const asset = await this.prisma.client.asset.findFirst({
      where: { id: assetId, projectId: scene.projectId },
      select: { id: true },
    });
    if (!asset) throw referenceNotFound('asset');
    await this.prisma.client.$transaction(async (tx) => {
      const now = new Date();
      // A clip starts from the keyframe: a new keyframe clears the scene's clip (M5 design §6.4).
      const previous = await tx.sceneKeyframe.findUnique({ where: { storyboardSceneId: sceneId } });
      if (previous && previous.assetId !== assetId) {
        const clip = await tx.sceneClip.findUnique({ where: { storyboardSceneId: sceneId } });
        if (clip) {
          await tx.sceneClip.delete({ where: { storyboardSceneId: sceneId } });
          await tx.sceneClipEvent.create({
            data: {
              projectId: scene.projectId,
              storyboardSceneId: sceneId,
              assetId: clip.assetId,
              selectedById: actor.userId,
              reason: 'cleared',
            },
          });
        }
      }
      await tx.sceneKeyframe.upsert({
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
      await tx.sceneKeyframeEvent.create({
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

  /** Candidate/upload review (editor): images, references, clips and audio (M5). */
  async review(
    actor: Actor,
    assetId: string,
    decision: 'approved' | 'rejected',
  ): Promise<AssetDto> {
    const asset = await this.prisma.client.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw notFound('asset');
    await this.access.require(actor, asset.projectId, 'editor', { mutation: true });
    if (!REVIEWABLE.has(asset.assetType)) {
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.AssetNotReviewable,
        'Only images, reference images, clips and audio are reviewed.',
      );
    }
    if (asset.archivedAt) throw archived('asset');
    const updated = await this.prisma.client.asset.update({
      where: { id: assetId },
      data: { approvalStatus: decision, reviewedById: actor.userId, reviewedAt: new Date() },
    });
    return toAssetDto(updated);
  }

  // ------------------------------------------------------------------- planning

  private async plan(
    actor: Actor,
    storyboardId: string,
    request: ImageGenerationRequest,
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
    if (missingGates(item.format, 'images', gates).length > 0) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.StoryboardNotApproved,
        'Images are generated only for the approved storyboard.',
      );
    }

    const route = await this.prisma.client.aiTaskRoute.findUnique({
      where: { task: 'image_generation' },
      include: { model: { select: { modelKey: true } } },
    });
    const modelKey = request.modelKey ?? route?.model.modelKey;
    if (modelKey === undefined) {
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.NoModelRoute,
        'No model is routed to image generation.',
      );
    }
    const aspectRatio = ASPECT[item.aspectRatio] ?? '9:16';
    const count = request.count ?? IMAGE_CANDIDATES.default;

    const selected = request.sceneIds
      ? request.sceneIds.map((id) => {
          const s = storyboard.scenes.find((scene) => scene.id === id);
          if (!s) throw referenceNotFound('scene');
          return s;
        })
      : storyboard.scenes;
    const maxRefs = Math.max(...selected.map((s) => referencesOf(s).length), 0);

    // Route once with the largest reference count; the resolution defaults to 2K when supported.
    let row: Awaited<ReturnType<ImageService['route']>>['row'];
    let resolution: ImageResolution | null = request.resolution ?? null;
    try {
      const probe = await this.images.route(
        { qualityTier: 'economy' },
        { modelKey, aspectRatio, count: 1, references: [] },
      );
      if (
        resolution === null &&
        probe.row.imageConstraints?.resolutions.includes(DEFAULT_IMAGE_RESOLUTION)
      ) {
        resolution = DEFAULT_IMAGE_RESOLUTION;
      }
      const perCall = Math.min(count, probe.row.imageConstraints?.maxImages ?? 1);
      const placeholder = { mimeType: 'image/png' as const, bytes: new Uint8Array([0]) };
      ({ row } = await this.images.route(
        { qualityTier: 'economy' },
        {
          modelKey,
          aspectRatio,
          count: perCall,
          ...(resolution ? { resolution } : {}),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
          references: Array.from({ length: maxRefs }, () => placeholder),
        },
      ));
    } catch (e) {
      if (e instanceof RoutingError) {
        throw error(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.NoModelRoute, e.message);
      }
      if (e instanceof ImageConstraintError) {
        const refs = e.issues.some((i) => i.includes('reference'));
        throw error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          refs ? ApiErrorCode.ReferencesExceedModelLimit : ApiErrorCode.ModelLimits,
          e.message,
        );
      }
      throw e;
    }
    const prices = activePrices(row.prices, new Date());

    const sceneIds = selected.map((s) => s.id);
    const [keyframes, activeJobs] = await Promise.all([
      this.prisma.client.sceneKeyframe.findMany({ where: { storyboardSceneId: { in: sceneIds } } }),
      this.prisma.client.generationJob.findMany({
        where: { storyboardSceneId: { in: sceneIds }, status: { in: ['queued', 'running'] } },
        select: { storyboardSceneId: true },
      }),
    ]);
    const scenes: ScenePlan[] = [];
    for (const scene of selected) {
      const references = referencesOf(scene);
      const sceneHash = sceneContentHash({
        scene: imageScene(scene),
        aspectRatio,
        referenceAssetIds: references.map((r) => r.assetId),
      });
      const key = executionKey({
        kind: 'image_generation',
        contentItemId: item.id,
        brief: { sceneHash, count, resolution, seed: request.seed ?? null },
        inputVersionIds: references.map((r) => r.assetId),
        promptTemplateId: IMAGE_PROMPT_TEMPLATE_ID,
        modelId: row.candidate.modelId,
      });
      const base = {
        scene,
        imageScene: imageScene(scene),
        references,
        sceneHash,
        executionKey: key,
      };
      const explicit = request.sceneIds?.includes(scene.id) ?? false;
      let action: ScenePlan['action'] = 'generate';
      let reuseAssetId: string | undefined;
      if (activeJobs.some((j) => j.storyboardSceneId === scene.id)) action = 'skip_in_progress';
      else if (keyframes.some((k) => k.storyboardSceneId === scene.id) && !explicit)
        action = 'skip_has_keyframe';
      else if (!request.regenerate) {
        const reused = await this.reusableKeyframe(item.id, sceneHash);
        if (reused && !keyframes.some((k) => k.storyboardSceneId === scene.id)) {
          action = 'reuse_keyframe';
          reuseAssetId = reused;
        } else if (
          await this.prisma.client.generationJob.findFirst({
            where: { contentItemId: item.id, executionKey: key, status: 'succeeded' },
            select: { id: true },
          })
        ) {
          action = 'skip_existing_result';
        }
      }
      const estimate =
        action === 'generate'
          ? estimateImageCost({
              prices,
              count,
              references: references.length,
              resolution: resolution ?? undefined,
              aspectRatio,
            })
          : UsdAmount.ZERO;
      scenes.push({ ...base, action, estimate, ...(reuseAssetId ? { reuseAssetId } : {}) });
    }
    return {
      item: { id: item.id, projectId: item.projectId, status: item.status },
      storyboardId: storyboard.id,
      modelId: row.candidate.modelId,
      modelKey: row.candidate.modelKey,
      aspectRatio,
      resolution,
      count,
      zeroDataRetention: request.modelKey === undefined && (route?.zeroDataRetention ?? false),
      scenes,
    };
  }

  /** An approved keyframe image generated for an identical scene of this content item. */
  private async reusableKeyframe(
    contentItemId: string,
    sceneHash: string,
  ): Promise<string | undefined> {
    const rows = await this.prisma.client.$queryRaw<{ asset_id: string }[]>`
      SELECT k.asset_id FROM scene_keyframes k JOIN assets a ON a.id = k.asset_id
      WHERE a.content_item_id = ${contentItemId}::uuid AND a.approval_status = 'approved'
        AND a.archived_at IS NULL AND a.metadata ->> 'sceneHash' = ${sceneHash}
      ORDER BY k.selected_at DESC LIMIT 1`;
    return rows[0]?.asset_id;
  }

  /** Every reference must have its file in storage before paid work is queued. */
  private async assertReferenceFiles(
    projectId: string,
    scenes: readonly ScenePlan[],
  ): Promise<void> {
    const store = this.storage.require();
    const ids = [...new Set(scenes.flatMap((s) => s.references.map((r) => r.assetId)))];
    const assets = await this.prisma.client.asset.findMany({
      where: { projectId, id: { in: ids } },
      select: { id: true, storageKey: true, archivedAt: true },
    });
    for (const id of ids) {
      const asset = assets.find((a) => a.id === id);
      let present = false;
      try {
        present =
          asset !== undefined &&
          asset.archivedAt === null &&
          (await store.head(asset.storageKey)) !== null;
      } catch (e) {
        storageFailure(e);
      }
      if (!present) {
        throw error(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ApiErrorCode.ReferenceFileMissing,
          `Reference image ${id} has no stored file. Upload it (POST /projects/:projectId/assets/upload) and link the upload instead.`,
        );
      }
    }
  }

  private async loadStoryboard(storyboardId: string) {
    const storyboard = await this.prisma.client.storyboardVersion.findUnique({
      where: { id: storyboardId },
      include: { scenes: { include: SCENE_INCLUDE, orderBy: { sceneNumber: 'asc' } } },
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

const REVIEWABLE: ReadonlySet<string> = new Set(['image', 'reference', 'video', 'audio']);

const ASPECT: Readonly<Record<string, '9:16' | '1:1' | '16:9'>> = {
  ratio_9_16: '9:16',
  ratio_1_1: '1:1',
  ratio_16_9: '16:9',
};

const sceneHashOf = (a: Asset): string | undefined => {
  const meta = a.metadata as Record<string, unknown> | null;
  const hash = meta?.['sceneHash'];
  return typeof hash === 'string' ? hash : undefined;
};

function estimateDto(plan: Plan): ImageEstimateDto {
  const generating = plan.scenes.filter((s) => s.action === 'generate');
  const unknownCost = generating.some((s) => s.estimate === null);
  return {
    modelKey: plan.modelKey,
    resolution: plan.resolution as ImageEstimateDto['resolution'],
    count: plan.count,
    scenes: plan.scenes.map((s) => ({
      sceneId: s.scene.id,
      sceneNumber: s.scene.sceneNumber,
      action: s.action,
      references: s.references.length,
      estimatedUsd: s.estimate === null ? null : s.estimate.toString(),
    })),
    totalEstimatedUsd: unknownCost
      ? null
      : UsdAmount.sum(generating.map((s) => s.estimate ?? UsdAmount.ZERO)).toString(),
    unknownCost,
  };
}
