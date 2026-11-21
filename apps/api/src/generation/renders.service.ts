import { HttpStatus, Injectable } from '@nestjs/common';

import { UsdAmount } from '@acf/ai-core';
import {
  ApiErrorCode,
  type CostReportDto,
  type CreateRenderRequest,
  type CreateRenderResponseDto,
  type RenderDto,
  type RenderListDto,
  type RenderManifestDocumentDto,
  type RenderPlanDto,
} from '@acf/contracts';
import {
  activeRenderJobKey,
  DEFAULT_MUSIC_VOLUME_DB,
  nextContentStatus,
  renderExecutionKey,
  renderManifestSchema,
  renderSettings,
  renderSettingsSchema,
  upscaledFrom,
  type ContentStatus,
  type RenderAudio,
  type RenderManifest,
} from '@acf/content-domain';
import {
  databaseErrorInfo,
  PostgresSqlState,
  type Asset,
  type GenerationJob,
  type Prisma,
  uuidv7,
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
import { costSummary, metaString, toJobDto } from './mappers.js';

/** The registry entry of the local renderer: every job names a model; rendering uses FFmpeg. */
export const LOCAL_RENDER_PROVIDER = 'local';
export const LOCAL_RENDER_MODEL = 'local/ffmpeg-render';

const error = (status: number, code: string, message: string, current?: unknown) =>
  new ApiError({ status, code, message, ...(current === undefined ? {} : { current }) });

type Blocker = RenderPlanDto['blockers'][number];

/** How the plan treats voice-overs (P4 S4, S5); the default is the M6 plan. */
interface PlanOptions {
  readonly voiceEnabled: boolean;
  readonly voiceOffsetsMs: ReadonlyMap<string, number>;
  /** The render has an `audio` block: scenes record `clipHasAudio`. */
  readonly mixed: boolean;
}
const M6_PLAN: PlanOptions = { voiceEnabled: true, voiceOffsetsMs: new Map(), mixed: false };

/** The clip's probe metadata says it has an audio stream (M5 `metadata.video.hasAudio`). */
function hasAudio(metadata: unknown): boolean {
  const video =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)['video']
      : undefined;
  return (
    typeof video === 'object' &&
    video !== null &&
    (video as Record<string, unknown>)['hasAudio'] === true
  );
}

interface PlanResult {
  readonly dto: RenderPlanDto;
  readonly manifest: Omit<RenderManifest, 'music'> | null;
  readonly item: { id: string; projectId: string; status: ContentStatus; voiceEnabled: boolean };
}

const RENDER_INCLUDE = {
  generationJob: { include: { model: { select: { modelKey: true } }, events: false } },
  videoAsset: true,
  subtitleAsset: true,
  thumbnailAsset: true,
} as const satisfies Prisma.RenderInclude;

type RenderRow = Prisma.RenderGetPayload<{ include: typeof RENDER_INCLUDE }>;

/**
 * Renders, gate 5 and export (M6 design §4–§11). The API checks the inputs, freezes the manifest
 * and records intent; the worker renders with FFmpeg. A person approves a render; the approved
 * render's package (MP4, SRT, thumbnail, manifest, cost report) is then exported.
 */
@Injectable()
export class RendersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly queue: GenerationQueue,
    private readonly storage: ObjectStoreService,
  ) {}

  async plan(actor: Actor, contentId: string): Promise<RenderPlanDto> {
    return (await this.buildPlan(actor, contentId, 'viewer')).dto;
  }

  async create(
    actor: Actor,
    contentId: string,
    request: CreateRenderRequest,
  ): Promise<CreateRenderResponseDto> {
    const plan = await this.buildPlan(actor, contentId, 'editor', {
      voiceEnabled: request.audio?.voice?.enabled ?? true,
      voiceOffsetsMs: new Map(
        (request.audio?.scenes ?? []).map((sc) => [sc.sceneId, sc.voiceOffsetMs ?? 0]),
      ),
      mixed: request.audio !== undefined,
    });
    const first = plan.dto.blockers[0];
    if (first || !plan.manifest) {
      throw error(
        HttpStatus.CONFLICT,
        first?.code === 'STORAGE_NOT_CONFIGURED'
          ? ApiErrorCode.StorageNotConfigured
          : (first?.code ?? ApiErrorCode.StoryboardNotApproved),
        first?.message ?? 'Nothing to render.',
        plan.dto,
      );
    }
    const music = request.music ? await this.music(plan.item.projectId, request.music) : null;
    // P4d: without voice-over the render always carries the audio block (voice off, render.v2).
    const audioRequest =
      request.audio ?? (plan.item.voiceEnabled ? undefined : { voice: { enabled: false } });
    const audio = audioRequest
      ? await this.audio(plan.item.projectId, plan.manifest, {
          ...audioRequest,
          ...(plan.item.voiceEnabled
            ? {}
            : { voice: { ...audioRequest.voice, enabled: false } }),
        })
      : undefined;
    // P4 S2: without `audio`, the manifest and settings are exactly the M6 ones (same key).
    const manifest: RenderManifest = { ...plan.manifest, music, ...(audio ? { audio } : {}) };
    const settings = renderSettings(request.captions?.burnIn ?? true, audio !== undefined);
    const key = renderExecutionKey(manifest, settings);

    if (!request.regenerate) {
      const earlier = await this.prisma.client.render.findFirst({
        where: {
          contentItemId: plan.item.id,
          executionKey: key,
          generationJob: { status: { in: ['queued', 'running', 'succeeded'] } },
        },
        include: RENDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
      if (earlier) return { render: await this.toDto(earlier), reused: true };
    }

    if (plan.dto.renderInProgress) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.RenderInProgress,
        'A render is already queued or running for this content item.',
      );
    }
    const modelId = await this.localRenderModel();
    let render: RenderRow;
    try {
      render = await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, plan.item.id);
        let next: ContentStatus;
        try {
          next = nextContentStatus(status, { type: 'render_queued' });
        } catch {
          throw error(
            HttpStatus.CONFLICT,
            ApiErrorCode.InvalidPipelineState,
            `A render cannot start while the content item is ${status}.`,
          );
        }
        const run = await tx.productionRun.create({
          data: {
            projectId: plan.item.projectId,
            contentItemId: plan.item.id,
            requestedById: actor.userId,
          },
        });
        const renderId = uuidv7();
        const job = await tx.generationJob.create({
          data: {
            projectId: plan.item.projectId,
            contentItemId: plan.item.id,
            productionRunId: run.id,
            kind: 'render',
            activeKey: activeRenderJobKey(plan.item.id),
            idempotencyKey: `render:${renderId}`,
            executionKey: key,
            input: { renderId },
            previousContentStatus: status,
            promptTemplateId: settings.renderer,
            modelId,
            requestedById: actor.userId,
          },
        });
        await tx.jobEvent.create({
          data: {
            projectId: plan.item.projectId,
            jobId: job.id,
            toStatus: 'queued',
            attempt: 0,
            detail: { type: 'created', renderId },
          },
        });
        const created = await tx.render.create({
          data: {
            id: renderId,
            projectId: plan.item.projectId,
            contentItemId: plan.item.id,
            storyboardVersionId: manifest.storyboardVersionId,
            generationJobId: job.id,
            manifest,
            settings,
            executionKey: key,
            upscaledFrom: upscaledFrom(manifest),
            createdById: actor.userId,
          },
          include: RENDER_INCLUDE,
        });
        if (next !== status) {
          await tx.contentItem.update({ where: { id: plan.item.id }, data: { status: next } });
        }
        return created;
      });
    } catch (e) {
      if (databaseErrorInfo(e)?.sqlState === PostgresSqlState.UNIQUE_VIOLATION) {
        throw error(
          HttpStatus.CONFLICT,
          ApiErrorCode.RenderInProgress,
          'A render is already queued or running for this content item.',
        );
      }
      throw e;
    }
    await this.queue.enqueue(render.generationJobId, 'render');
    return { render: await this.toDto(render), reused: false };
  }

  async list(actor: Actor, contentId: string): Promise<RenderListDto> {
    const item = await this.loadItem(contentId);
    await this.access.require(actor, item.projectId, 'viewer');
    const rows = await this.prisma.client.render.findMany({
      where: { contentItemId: contentId },
      include: RENDER_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return { items: await Promise.all(rows.map((r) => this.toDto(r, item.approvedRenderId))) };
  }

  async get(actor: Actor, renderId: string): Promise<RenderDto> {
    const render = await this.load(renderId);
    await this.access.require(actor, render.projectId, 'viewer');
    return this.toDto(render);
  }

  /** Gate 5: approve a rendered, unreviewed render; it becomes the item's approved export. */
  async approve(actor: Actor, renderId: string, note: string | undefined): Promise<RenderDto> {
    const render = await this.load(renderId);
    await this.access.require(actor, render.projectId, 'editor', { mutation: true });
    this.assertReviewable(render);
    await this.prisma.client.$transaction(async (tx) => {
      const status = await lockContent(tx, render.contentItemId);
      const { count } = await tx.render.updateMany({
        where: { id: renderId, reviewStatus: 'pending' },
        data: {
          reviewStatus: 'approved',
          reviewedById: actor.userId,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
      });
      if (count !== 1) throw this.notReviewable();
      let next: ContentStatus = status;
      try {
        next = nextContentStatus(status, { type: 'render_approved' });
      } catch {
        // The item moved on (e.g. new scene work): the pointer still records the approval.
      }
      await tx.contentItem.update({
        where: { id: render.contentItemId },
        data: { approvedRenderId: renderId, status: next },
      });
    });
    return this.get(actor, renderId);
  }

  async reject(actor: Actor, renderId: string, note: string): Promise<RenderDto> {
    const render = await this.load(renderId);
    await this.access.require(actor, render.projectId, 'editor', { mutation: true });
    this.assertReviewable(render);
    await this.prisma.client.$transaction(async (tx) => {
      const status = await lockContent(tx, render.contentItemId);
      const { count } = await tx.render.updateMany({
        where: { id: renderId, reviewStatus: 'pending' },
        data: {
          reviewStatus: 'rejected',
          reviewedById: actor.userId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });
      if (count !== 1) throw this.notReviewable();
      try {
        const next = nextContentStatus(status, { type: 'render_rejected' });
        await tx.contentItem.update({
          where: { id: render.contentItemId },
          data: { status: next },
        });
      } catch {
        // Not in quality review (e.g. an older render): the decision is recorded on the render.
      }
    });
    return this.get(actor, renderId);
  }

  /** Marks the approved render exported (idempotent); its package files are then downloadable. */
  async export(actor: Actor, renderId: string): Promise<RenderDto> {
    const render = await this.load(renderId);
    await this.access.require(actor, render.projectId, 'editor', { mutation: true });
    if (render.reviewStatus !== 'approved') {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.RenderNotApproved,
        'Only an approved render can be exported. Review it first.',
      );
    }
    if (!render.exportedAt) {
      await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, render.contentItemId);
        await tx.render.updateMany({
          where: { id: renderId, exportedAt: null },
          data: { exportedAt: new Date(), exportedById: actor.userId },
        });
        const item = await tx.contentItem.findUniqueOrThrow({
          where: { id: render.contentItemId },
          select: { approvedRenderId: true },
        });
        if (item.approvedRenderId === renderId) {
          try {
            const next = nextContentStatus(status, { type: 'render_exported' });
            await tx.contentItem.update({
              where: { id: render.contentItemId },
              data: { status: next },
            });
          } catch {
            // The item moved on; the export is recorded on the render.
          }
        }
      });
    }
    return this.get(actor, renderId);
  }

  async manifest(actor: Actor, renderId: string): Promise<RenderManifestDocumentDto> {
    const render = await this.load(renderId);
    await this.access.require(actor, render.projectId, 'viewer');
    const item = await this.prisma.client.contentItem.findUniqueOrThrow({
      where: { id: render.contentItemId },
      select: { id: true, title: true, language: true, approvedScriptVersionId: true },
    });
    const script = item.approvedScriptVersionId
      ? await this.prisma.client.scriptVersion.findUnique({
          where: { id: item.approvedScriptVersionId },
          select: { id: true, version: true, content: true },
        })
      : null;
    const outputs: RenderManifestDocumentDto['outputs'] = [];
    const add = (role: 'video' | 'subtitles' | 'thumbnail', a: Asset | null) => {
      if (a) {
        outputs.push({
          role,
          assetId: a.id,
          mimeType: a.mimeType,
          sizeBytes: Number(a.sizeBytes),
          checksumSha256: a.checksumSha256,
        });
      }
    };
    add('video', render.videoAsset);
    add('subtitles', render.subtitleAsset);
    add('thumbnail', render.thumbnailAsset);
    return {
      renderId: render.id,
      contentItem: { id: item.id, title: item.title, language: item.language },
      script,
      manifest: render.manifest,
      settings: render.settings,
      qc: render.qc,
      outputs,
      review: {
        status: render.reviewStatus,
        reviewedAt: render.reviewedAt?.toISOString() ?? null,
        exportedAt: render.exportedAt?.toISOString() ?? null,
      },
    };
  }

  /**
   * Every AI call of the content item (ledger), by stage; the subtotal of the calls behind the
   * assets this render used; unknown costs counted, never as zero.
   */
  async costReport(actor: Actor, renderId: string): Promise<CostReportDto> {
    const render = await this.load(renderId);
    await this.access.require(actor, render.projectId, 'viewer');
    const rows = await this.prisma.client.aiInvocation.findMany({
      where: { contentItemId: render.contentItemId },
      select: {
        generationJobId: true,
        costStatus: true,
        reportedCost: true,
        estimatedCost: true,
        generationJob: { select: { kind: true } },
      },
    });
    const parsed = renderManifestSchema.safeParse(render.manifest);
    const scenes = parsed.success ? parsed.data.scenes : [];
    const usedAssetIds = scenes.flatMap((s) =>
      [s.clipAssetId, s.voiceoverAssetId, s.keyframeAssetId].filter((x): x is string => x !== null),
    );
    const usedJobs = new Set(
      (
        await this.prisma.client.asset.findMany({
          where: { id: { in: usedAssetIds }, generationJobId: { not: null } },
          select: { generationJobId: true },
        })
      ).map((a) => a.generationJobId),
    );
    const stages = new Map<string, typeof rows>();
    for (const row of rows) {
      const stage = row.generationJob?.kind ?? 'other';
      stages.set(stage, [...(stages.get(stage) ?? []), row]);
    }
    return {
      contentItemId: render.contentItemId,
      renderId: render.id,
      currency: 'USD',
      total: costSummary(rows),
      byStage: [...stages.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stage, list]) => ({ stage, ...costSummary(list) })),
      usedInRender: costSummary(
        rows.filter((r) => r.generationJobId && usedJobs.has(r.generationJobId)),
      ),
      renderCostUsd: UsdAmount.ZERO.toString(),
      generatedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------- planning

  private async buildPlan(
    actor: Actor,
    contentId: string,
    role: 'viewer' | 'editor',
    options: PlanOptions = M6_PLAN,
  ): Promise<PlanResult> {
    const item = await this.loadItem(contentId);
    await this.access.require(actor, item.projectId, role, { mutation: role === 'editor' });
    if (item.archivedAt) throw archived('content item');
    // P4d: an item without voice-over never needs or uses one.
    if (!item.voiceEnabled) options = { ...options, voiceEnabled: false, mixed: true };
    const blockers: Blocker[] = [];
    const block = (code: Blocker['code'], message: string, sceneNumber: number | null = null) => {
      blockers.push({ code, message, sceneNumber });
    };
    const musicOptions = await this.prisma.client.asset.findMany({
      where: {
        projectId: item.projectId,
        assetType: 'audio',
        sourceType: 'upload',
        approvalStatus: 'approved',
        archivedAt: null,
        metadata: { path: ['purpose'], equals: 'music' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const sfxOptions = await this.prisma.client.asset.findMany({
      where: {
        projectId: item.projectId,
        assetType: 'audio',
        sourceType: 'upload',
        approvalStatus: 'approved',
        archivedAt: null,
        metadata: { path: ['purpose'], equals: 'sfx' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const renderInProgress =
      (await this.prisma.client.generationJob.count({
        where: { contentItemId: item.id, kind: 'render', status: { in: ['queued', 'running'] } },
      })) > 0;
    const storyboardId = item.approvedStoryboardVersionId;
    if (!storyboardId) {
      block(
        'STORYBOARD_NOT_APPROVED',
        'Approve a storyboard, keyframes, clips and voice-overs first.',
      );
      return {
        dto: {
          contentItemId: item.id,
          storyboardVersionId: null,
          scenes: [],
          totalSeconds: 0,
          blockers,
          upscaledFrom: null,
          musicOptions: musicOptions.map(toAssetDto),
          sfxOptions: sfxOptions.map(toAssetDto),
          renderInProgress,
        },
        manifest: null,
        item,
      };
    }
    const scenes = await this.prisma.client.storyboardScene.findMany({
      where: { storyboardVersionId: storyboardId },
      orderBy: { sceneNumber: 'asc' },
      include: {
        clip: { include: { asset: { include: { generationJob: { include: { model: true } } } } } },
        voiceover: {
          include: { asset: { include: { generationJob: { include: { model: true } } } } },
        },
        keyframe: { include: { asset: true } },
      },
    });
    const store = this.storage.store;
    if (!store) block('STORAGE_NOT_CONFIGURED', 'Object storage is not configured.');
    const exists = async (a: Asset): Promise<boolean> => {
      if (!store) return false;
      try {
        return (await store.head(a.storageKey)) !== null;
      } catch (e) {
        storageFailure(e);
      }
    };
    const planScenes: RenderPlanDto['scenes'] = [];
    const manifestScenes: RenderManifest['scenes'] = [];
    for (const scene of scenes) {
      const durationMs = Math.round(Number(scene.durationSeconds) * 1000);
      const text = scene.voiceOverSegment.trim();
      const clip = scene.clip?.asset ?? null;
      const chosenVoice = scene.voiceover?.asset ?? null;
      // P4 S5: with the voice layer off, no voice-over is needed or used.
      const voice = options.voiceEnabled ? chosenVoice : null;
      const offsetMs = options.voiceOffsetsMs.get(scene.id) ?? 0;
      const keyframe = scene.keyframe?.asset ?? null;
      planScenes.push({
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        durationSeconds: durationMs / 1000,
        text,
        clip: clip ? toAssetDto(clip) : null,
        voiceover: chosenVoice ? toAssetDto(chosenVoice) : null,
        keyframe: keyframe ? toAssetDto(keyframe) : null,
        clipHasAudio: clip ? hasAudio(clip.metadata) : false,
      });
      if (!clip) {
        block(
          'CLIPS_INCOMPLETE',
          `Scene ${String(scene.sceneNumber)} has no chosen clip.`,
          scene.sceneNumber,
        );
      } else if (store && !(await exists(clip))) {
        block(
          'INPUT_FILE_MISSING',
          `The clip of scene ${String(scene.sceneNumber)} has no stored file.`,
          scene.sceneNumber,
        );
      }
      if (text && !voice && options.voiceEnabled) {
        block(
          'VOICEOVERS_INCOMPLETE',
          `Scene ${String(scene.sceneNumber)} has narration but no chosen voice-over.`,
          scene.sceneNumber,
        );
      }
      if (voice) {
        if (offsetMs + (voice.durationMs ?? 0) > durationMs) {
          block(
            'VOICEOVER_EXCEEDS_SCENE',
            `The voice-over of scene ${String(scene.sceneNumber)} (${((voice.durationMs ?? 0) / 1000).toFixed(1)} s${offsetMs > 0 ? `, starting at ${(offsetMs / 1000).toFixed(1)} s` : ''}) is longer than the scene (${(durationMs / 1000).toFixed(1)} s). Shorten the text, speed up the voice or reduce the offset.`,
            scene.sceneNumber,
          );
        } else if (store && !(await exists(voice))) {
          block(
            'INPUT_FILE_MISSING',
            `The voice-over of scene ${String(scene.sceneNumber)} has no stored file.`,
            scene.sceneNumber,
          );
        }
      }
      if (clip) {
        manifestScenes.push({
          sceneId: scene.id,
          sceneNumber: scene.sceneNumber,
          durationMs,
          clipAssetId: clip.id,
          clipDurationMs: clip.durationMs ?? durationMs,
          clipWidth: clip.width,
          clipHeight: clip.height,
          keyframeAssetId: keyframe?.id ?? null,
          voiceoverAssetId: voice?.id ?? null,
          voiceoverDurationMs: voice ? (voice.durationMs ?? null) : null,
          text: voice ? text : '',
          clipModel:
            clip.generationJob?.model.modelKey ?? metaString(clip.metadata, 'model') ?? null,
          voiceoverModel: voice?.generationJob?.model.modelKey ?? null,
          ...(options.mixed ? { clipHasAudio: hasAudio(clip.metadata) } : {}),
        });
      }
    }
    if (scenes.length === 0) block('CLIPS_INCOMPLETE', 'The approved storyboard has no scenes.');
    const manifest =
      blockers.length === 0 ? { storyboardVersionId: storyboardId, scenes: manifestScenes } : null;
    return {
      dto: {
        contentItemId: item.id,
        storyboardVersionId: storyboardId,
        scenes: planScenes,
        totalSeconds: planScenes.reduce((sum, s) => sum + s.durationSeconds, 0),
        blockers,
        upscaledFrom: manifest ? upscaledFrom({ ...manifest, music: null }) : null,
        musicOptions: musicOptions.map(toAssetDto),
        sfxOptions: sfxOptions.map(toAssetDto),
        renderInProgress,
      },
      manifest,
      item,
    };
  }

  /**
   * Resolves the requested audio layers (P4 S1–S4) against the plan: scene IDs become scene
   * numbers, SFX get absolute start times and must be approved `sfx` uploads of the project.
   */
  private async audio(
    projectId: string,
    plan: Omit<RenderManifest, 'music'>,
    request: NonNullable<CreateRenderRequest['audio']>,
  ): Promise<RenderAudio> {
    const starts = new Map<string, { sceneNumber: number; startMs: number; durationMs: number }>();
    let at = 0;
    for (const scene of plan.scenes) {
      starts.set(scene.sceneId, {
        sceneNumber: scene.sceneNumber,
        startMs: at,
        durationMs: scene.durationMs,
      });
      at += scene.durationMs;
    }
    const sfxInvalid = (message: string) =>
      error(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.SfxInvalid, message);
    const sfxIds = [...new Set((request.sfx ?? []).map((x) => x.assetId))];
    const sfxAssets = await this.prisma.client.asset.findMany({
      where: { id: { in: sfxIds }, projectId },
    });
    const sfx = (request.sfx ?? []).map((x) => {
      const asset = sfxAssets.find((a) => a.id === x.assetId);
      if (
        !asset ||
        asset.assetType !== 'audio' ||
        asset.sourceType !== 'upload' ||
        asset.approvalStatus !== 'approved' ||
        asset.archivedAt !== null ||
        metaString(asset.metadata, 'purpose') !== 'sfx'
      ) {
        throw sfxInvalid('Sound effects must be approved sound-effect uploads of this project.');
      }
      const scene = starts.get(x.sceneId);
      if (!scene) throw sfxInvalid('A sound effect names a scene that is not in the render.');
      if (x.offsetMs >= scene.durationMs) {
        throw sfxInvalid(
          `A sound effect starts after the end of scene ${String(scene.sceneNumber)}.`,
        );
      }
      return {
        assetId: asset.id,
        sceneNumber: scene.sceneNumber,
        startMs: scene.startMs + x.offsetMs,
        gainDb: x.gainDb ?? 0,
        licenseNote: asset.sourceNote,
      };
    });
    const scenes = (request.scenes ?? []).map((x) => {
      const scene = starts.get(x.sceneId);
      if (!scene) throw referenceNotFound('scene');
      return {
        sceneNumber: scene.sceneNumber,
        voiceOffsetMs: x.voiceOffsetMs ?? 0,
        muteMusic: x.muteMusic ?? false,
      };
    });
    return {
      voice: { enabled: request.voice?.enabled ?? true, gainDb: request.voice?.gainDb ?? 0 },
      music: {
        fadeInMs: request.music?.fadeInMs ?? 0,
        fadeOutMs: request.music?.fadeOutMs ?? 1500,
        ducking: request.music?.ducking ?? true,
      },
      clipAudio: {
        enabled: request.clipAudio?.enabled ?? false,
        gainDb: request.clipAudio?.gainDb ?? 0,
      },
      sfx: sfx.sort((a, b) => a.startMs - b.startMs || a.assetId.localeCompare(b.assetId)),
      scenes: scenes.sort((a, b) => a.sceneNumber - b.sceneNumber),
    };
  }

  private async music(
    projectId: string,
    request: NonNullable<CreateRenderRequest['music']>,
  ): Promise<RenderManifest['music']> {
    const asset = await this.prisma.client.asset.findFirst({
      where: { id: request.assetId, projectId },
    });
    if (
      !asset ||
      asset.assetType !== 'audio' ||
      asset.sourceType !== 'upload' ||
      asset.approvalStatus !== 'approved' ||
      asset.archivedAt !== null ||
      metaString(asset.metadata, 'purpose') !== 'music'
    ) {
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.MusicInvalid,
        'Music must be an approved music upload of this project (with its licence note).',
      );
    }
    return {
      assetId: asset.id,
      volumeDb: request.volumeDb ?? DEFAULT_MUSIC_VOLUME_DB,
      licenseNote: asset.sourceNote,
    };
  }

  /** The registry entry that render jobs name (created on first use; never routed or priced). */
  private async localRenderModel(): Promise<string> {
    const provider = await this.prisma.client.aiProvider.upsert({
      where: { key: LOCAL_RENDER_PROVIDER },
      create: {
        key: LOCAL_RENDER_PROVIDER,
        name: 'Local (FFmpeg in the worker)',
        kind: 'direct',
        status: 'enabled',
        notes: 'Rendering (M6) runs FFmpeg in the worker: no external provider, no cost.',
      },
      update: {},
    });
    const model = await this.prisma.client.aiModel.upsert({
      where: { providerId_modelKey: { providerId: provider.id, modelKey: LOCAL_RENDER_MODEL } },
      create: {
        providerId: provider.id,
        modelKey: LOCAL_RENDER_MODEL,
        displayName: 'FFmpeg render',
        qualityTier: 'economy',
        status: 'enabled',
      },
      update: {},
    });
    return model.id;
  }

  private assertReviewable(render: RenderRow): void {
    if (
      render.generationJob.status !== 'succeeded' ||
      !render.videoAssetId ||
      render.reviewStatus !== 'pending'
    ) {
      throw this.notReviewable();
    }
  }

  private notReviewable(): ApiError {
    return error(
      HttpStatus.CONFLICT,
      ApiErrorCode.RenderNotReviewable,
      'Only a finished render that has not been reviewed can be approved or rejected.',
    );
  }

  private async loadItem(contentId: string) {
    const item = await this.prisma.client.contentItem.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        projectId: true,
        status: true,
        archivedAt: true,
        approvedStoryboardVersionId: true,
        approvedRenderId: true,
        voiceEnabled: true,
      },
    });
    if (!item) throw notFound('content item');
    return item;
  }

  private async load(renderId: string): Promise<RenderRow> {
    const render = await this.prisma.client.render.findUnique({
      where: { id: renderId },
      include: RENDER_INCLUDE,
    });
    if (!render) throw notFound('render');
    return render;
  }

  private async toDto(render: RenderRow, approvedRenderId?: string | null): Promise<RenderDto> {
    const job: GenerationJob = render.generationJob;
    const [stageEvent, approved] = await Promise.all([
      this.prisma.client.jobEvent.findFirst({
        where: { jobId: job.id, detail: { path: ['type'], equals: 'render_stage' } },
        orderBy: { createdAt: 'desc' },
        select: { detail: true },
      }),
      approvedRenderId === undefined
        ? this.prisma.client.contentItem
            .findUnique({ where: { id: render.contentItemId }, select: { approvedRenderId: true } })
            .then((i) => i?.approvedRenderId ?? null)
        : Promise.resolve(approvedRenderId),
    ]);
    const settings = renderSettingsSchema.safeParse(render.settings);
    const manifest = renderManifestSchema.safeParse(render.manifest);
    const qc = render.qc as RenderDto['qc'] | null;
    return {
      id: render.id,
      projectId: render.projectId,
      contentItemId: render.contentItemId,
      storyboardVersionId: render.storyboardVersionId,
      status: job.status,
      job: toJobDto(job, render.generationJob.model.modelKey, costSummary([])),
      stage: metaString(stageEvent?.detail, 'stage') ?? null,
      burnInCaptions: settings.success ? settings.data.captions.burnIn : true,
      musicAssetId: manifest.success ? (manifest.data.music?.assetId ?? null) : null,
      upscaledFrom: render.upscaledFrom,
      durationMs: render.durationMs,
      video: render.videoAsset ? toAssetDto(render.videoAsset) : null,
      subtitles: render.subtitleAsset ? toAssetDto(render.subtitleAsset) : null,
      thumbnail: render.thumbnailAsset ? toAssetDto(render.thumbnailAsset) : null,
      qc: qc
        ? {
            passed: qc.passed,
            findings: qc.findings,
            measured: qc.measured,
            ffmpeg: qc.ffmpeg ?? null,
            elapsedMs: qc.elapsedMs ?? null,
          }
        : null,
      reviewStatus: render.reviewStatus,
      reviewedAt: render.reviewedAt?.toISOString() ?? null,
      reviewNote: render.reviewNote,
      isApproved: approved === render.id,
      exportedAt: render.exportedAt?.toISOString() ?? null,
      createdAt: render.createdAt.toISOString(),
    };
  }
}
