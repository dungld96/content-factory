import { HttpStatus, Injectable } from '@nestjs/common';

import { activePrices, assessTtsCost, ttsCharacters, UsdAmount } from '@acf/ai-core';
import { MediaConstraintError, RoutingError, TtsService } from '@acf/ai-runtime';
import {
  ApiErrorCode,
  type GenerationJobDto,
  type StoryboardVoiceoversDto,
  type VoiceoverEstimateDto,
  type VoiceoverGenerateResponseDto,
  type VoiceoverGenerationRequest,
} from '@acf/contracts';
import {
  activeSceneJobKey,
  executionKey,
  missingGates,
  nextContentStatus,
  TTS_TEMPLATE_ID,
  voiceoverContentHash,
  type ContentStatus,
  type GateKey,
  type TtsJobInput,
  type VoiceSnapshot,
} from '@acf/content-domain';
import {
  databaseErrorInfo,
  PostgresSqlState,
  type Asset,
  type GenerationJob,
  type StoryboardScene,
} from '@acf/database';

import type { Actor } from '../auth/actor.js';
import { ApiError } from '../common/api-error.js';
import { archived, notFound, referenceNotFound } from '../common/domain-errors.js';
import { toAssetDto } from '../assets/assets.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { ProjectAccess } from '../projects/project-access.service.js';
import { GenerationQueue } from './generation.queue.js';
import { lockContent } from './generation.service.js';
import { costSummary, metaString, toJobDto } from './mappers.js';

type Action = VoiceoverEstimateDto['scenes'][number]['action'];

interface ScenePlan {
  readonly scene: StoryboardScene;
  readonly text: string;
  readonly action: Action;
  readonly hash: string | null;
  readonly executionKey: string | null;
  readonly estimate: UsdAmount | null;
  readonly reuseAssetId?: string;
}

interface Plan {
  readonly item: { id: string; projectId: string; status: ContentStatus };
  readonly storyboardId: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly voice: VoiceSnapshot;
  readonly scenes: readonly ScenePlan[];
}

const error = (status: number, code: string, message: string, current?: unknown) =>
  new ApiError({ status, code, message, ...(current === undefined ? {} : { current }) });

const voiceParams = (v: VoiceSnapshot) => ({
  voice: v.voice,
  language: v.language,
  speed: v.speed,
  instructions: v.instructions,
});

/**
 * Scene voice-overs (M5 design §7). Voice parameters come from the content item's voice profile
 * and are snapshotted into each job, so later profile edits never change past outputs.
 */
@Injectable()
export class VoiceoversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccess,
    private readonly tts: TtsService,
    private readonly queue: GenerationQueue,
  ) {}

  async estimate(
    actor: Actor,
    storyboardId: string,
    request: VoiceoverGenerationRequest,
  ): Promise<VoiceoverEstimateDto> {
    return estimateDto(await this.plan(actor, storyboardId, request, 'viewer'));
  }

  async generate(
    actor: Actor,
    storyboardId: string,
    request: VoiceoverGenerationRequest,
  ): Promise<VoiceoverGenerateResponseDto> {
    const plan = await this.plan(actor, storyboardId, request, 'editor');
    const estimate = estimateDto(plan);
    if (estimate.unknownCost && !request.acceptUnknownCost) {
      throw error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ApiErrorCode.UnknownCostNotAccepted,
        'The cost of these voice-overs cannot be estimated. Resend with acceptUnknownCost: true to proceed.',
        estimate,
      );
    }
    const toGenerate = plan.scenes.filter((s) => s.action === 'generate');
    let created: GenerationJob[];
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        const status = await lockContent(tx, plan.item.id);
        for (const s of plan.scenes.filter((p) => p.action === 'reuse_voiceover')) {
          const assetId = s.reuseAssetId ?? '';
          await tx.sceneVoiceover.upsert({
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
          await tx.sceneVoiceoverEvent.create({
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
            `Voice-overs cannot be generated while the content item is ${status}.`,
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
          const input: TtsJobInput = {
            storyboardVersionId: plan.storyboardId,
            sceneId: s.scene.id,
            sceneNumber: s.scene.sceneNumber,
            text: s.text,
            sceneDurationSeconds: Number(s.scene.durationSeconds),
            voice: plan.voice,
            voiceoverHash: s.hash ?? '',
            qualityTier: 'economy',
          };
          const job = await tx.generationJob.create({
            data: {
              projectId: plan.item.projectId,
              contentItemId: plan.item.id,
              productionRunId: run.id,
              kind: 'tts_generation',
              storyboardSceneId: s.scene.id,
              activeKey: activeSceneJobKey(s.scene.id, 'tts_generation'),
              idempotencyKey: `${s.scene.id}:tts_generation:${run.id}`,
              executionKey: s.executionKey ?? '',
              input,
              previousContentStatus: status,
              promptTemplateId: TTS_TEMPLATE_ID,
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
          'A voice-over job is already queued or running for one of these scenes.',
        );
      }
      throw e;
    }
    for (const job of created) await this.queue.enqueue(job.id, 'tts_generation');
    return {
      productionRunId: created[0]?.productionRunId ?? null,
      jobs: await this.jobDtos(created.map((j) => ({ ...j, model: { modelKey: plan.modelKey } }))),
      estimate,
    };
  }

  /** Per scene: selected voice-over, candidates (generated and imported) and jobs. */
  async view(actor: Actor, storyboardId: string): Promise<StoryboardVoiceoversDto> {
    const storyboard = await this.loadStoryboard(storyboardId);
    await this.access.require(actor, storyboard.projectId, 'viewer');
    const item = await this.prisma.client.contentItem.findUniqueOrThrow({
      where: { id: storyboard.contentItemId },
      select: { approvedStoryboardVersionId: true, voiceProfileId: true },
    });
    const sceneIds = storyboard.scenes.map((s) => s.id);
    const [selected, generated, imported, jobs] = await Promise.all([
      this.prisma.client.sceneVoiceover.findMany({
        where: { storyboardSceneId: { in: sceneIds } },
        include: { asset: true },
      }),
      this.prisma.client.asset.findMany({
        where: {
          contentItemId: storyboard.contentItemId,
          assetType: 'audio',
          sourceType: 'generated',
          archivedAt: null,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      // Imported narration (V8): project uploads marked as voice-over.
      this.prisma.client.asset.findMany({
        where: {
          projectId: storyboard.projectId,
          contentItemId: null,
          assetType: 'audio',
          sourceType: 'upload',
          archivedAt: null,
          metadata: { path: ['purpose'], equals: 'voiceover' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.client.generationJob.findMany({
        where: { storyboardSceneId: { in: sceneIds }, kind: 'tts_generation' },
        include: { model: { select: { modelKey: true } } },
        orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const voice = item.voiceProfileId ? await this.snapshot(item.voiceProfileId) : null;
    const jobDtos = await this.jobDtos(jobs);
    const scenes = storyboard.scenes.map((scene) => {
      const text = scene.voiceOverSegment.trim();
      const hash =
        voice && text
          ? voiceoverContentHash({
              text,
              modelId: voice.modelId,
              voice: voiceParams(voice.snapshot),
            })
          : undefined;
      const candidates: Asset[] = [
        ...generated.filter(
          (a) =>
            a.storyboardSceneId === scene.id ||
            (hash !== undefined && metaString(a.metadata, 'voiceoverHash') === hash),
        ),
        ...imported,
      ];
      const sceneJobs = jobs.filter((j) => j.storyboardSceneId === scene.id);
      const dtoOf = (job: GenerationJob | undefined) =>
        job ? (jobDtos.find((d) => d.id === job.id) ?? null) : null;
      const chosen = selected.find((v) => v.storyboardSceneId === scene.id);
      const durationSeconds = Number(scene.durationSeconds);
      return {
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
        durationSeconds,
        text,
        voiceover: chosen ? toAssetDto(chosen.asset) : null,
        candidates: candidates.map(toAssetDto),
        exceedsScene:
          chosen?.asset.durationMs !== undefined &&
          chosen.asset.durationMs !== null &&
          chosen.asset.durationMs > durationSeconds * 1000,
        activeJob: dtoOf(sceneJobs.find((j) => j.status === 'queued' || j.status === 'running')),
        lastJob: dtoOf(sceneJobs[0]),
      };
    });
    return {
      storyboardVersionId: storyboard.id,
      approved: item.approvedStoryboardVersionId === storyboard.id,
      voiceProfileId: item.voiceProfileId,
      voiceoversComplete:
        scenes.length > 0 && scenes.every((s) => s.text === '' || s.voiceover !== null),
      scenes,
    };
  }

  /** Selects an approved voice-over candidate (AC016 enforces approval and ownership). */
  async setVoiceover(
    actor: Actor,
    sceneId: string,
    assetId: string,
  ): Promise<StoryboardVoiceoversDto> {
    const scene = await this.prisma.client.storyboardScene.findUnique({
      where: { id: sceneId },
      select: { id: true, projectId: true, storyboardVersionId: true },
    });
    if (!scene) throw notFound('scene');
    await this.access.require(actor, scene.projectId, 'editor', { mutation: true });
    const view = await this.view(actor, scene.storyboardVersionId);
    const candidate = view.scenes
      .find((s) => s.sceneId === sceneId)
      ?.candidates.find((c) => c.id === assetId);
    if (!candidate) {
      const exists = await this.prisma.client.asset.findFirst({
        where: { id: assetId, projectId: scene.projectId },
        select: { id: true },
      });
      if (!exists) throw referenceNotFound('asset');
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.VoiceoverInvalid,
        "A voice-over must be generated for this scene's text or imported as a voice-over upload.",
      );
    }
    await this.prisma.client.$transaction(async (tx) => {
      const now = new Date();
      await tx.sceneVoiceover.upsert({
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
      await tx.sceneVoiceoverEvent.create({
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

  // ------------------------------------------------------------------- planning

  private async plan(
    actor: Actor,
    storyboardId: string,
    request: VoiceoverGenerationRequest,
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
        archivedAt: true,
        voiceProfileId: true,
        approvedScriptVersionId: true,
        approvedStoryboardVersionId: true,
      },
    });
    if (item.archivedAt) throw archived('content item');
    const gates = new Set<GateKey>();
    if (item.approvedScriptVersionId) gates.add('script_approved');
    if (item.approvedStoryboardVersionId === storyboard.id) gates.add('storyboard_approved');
    if (missingGates(item.format, 'voiceover', gates).length > 0) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.StoryboardNotApproved,
        'Voice-overs are generated only for the approved storyboard.',
      );
    }
    if (!item.voiceProfileId) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.VoiceProfileRequired,
        'Choose a voice profile for this content item first (PATCH /content/:contentId).',
      );
    }
    const profile = await this.snapshot(item.voiceProfileId);
    if (profile.archived) {
      throw error(
        HttpStatus.CONFLICT,
        ApiErrorCode.VoiceProfileRequired,
        "The content item's voice profile is archived. Choose another one.",
      );
    }

    let route: Awaited<ReturnType<TtsService['route']>>;
    try {
      route = await this.tts.route(
        { qualityTier: 'economy' },
        { modelKey: profile.modelKey, voice: profile.snapshot.voice },
      );
    } catch (e) {
      if (e instanceof RoutingError) {
        throw error(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.NoModelRoute, e.message);
      }
      if (e instanceof MediaConstraintError) {
        throw error(HttpStatus.UNPROCESSABLE_ENTITY, ApiErrorCode.ModelLimits, e.message);
      }
      throw e;
    }
    const modelId = route.row.candidate.modelId;
    const prices = activePrices(route.row.prices, new Date());

    const selected = request.sceneIds
      ? request.sceneIds.map((id) => {
          const s = storyboard.scenes.find((scene) => scene.id === id);
          if (!s) throw referenceNotFound('scene');
          return s;
        })
      : storyboard.scenes;
    const sceneIds = selected.map((s) => s.id);
    const [chosen, activeJobs] = await Promise.all([
      this.prisma.client.sceneVoiceover.findMany({
        where: { storyboardSceneId: { in: sceneIds } },
      }),
      this.prisma.client.generationJob.findMany({
        where: {
          storyboardSceneId: { in: sceneIds },
          kind: 'tts_generation',
          status: { in: ['queued', 'running'] },
        },
        select: { storyboardSceneId: true },
      }),
    ]);

    const scenes: ScenePlan[] = [];
    for (const scene of selected) {
      const text = scene.voiceOverSegment.trim();
      const skeleton = { scene, text, hash: null, executionKey: null, estimate: UsdAmount.ZERO };
      const explicit = request.sceneIds?.includes(scene.id) ?? false;
      if (!text) {
        scenes.push({ ...skeleton, action: 'skip_no_text' });
        continue;
      }
      if (activeJobs.some((j) => j.storyboardSceneId === scene.id)) {
        scenes.push({ ...skeleton, action: 'skip_in_progress' });
        continue;
      }
      const hash = voiceoverContentHash({
        text,
        modelId,
        voice: voiceParams(profile.snapshot),
      });
      const key = executionKey({
        kind: 'tts_generation',
        contentItemId: item.id,
        brief: { voiceoverHash: hash },
        inputVersionIds: [],
        promptTemplateId: TTS_TEMPLATE_ID,
        modelId,
      });
      const withKey = { ...skeleton, hash, executionKey: key };
      if (chosen.some((v) => v.storyboardSceneId === scene.id) && !explicit) {
        scenes.push({ ...withKey, action: 'skip_has_voiceover' });
        continue;
      }
      if (!request.regenerate) {
        const reused = await this.reusableVoiceover(item.id, hash);
        if (reused && !chosen.some((v) => v.storyboardSceneId === scene.id)) {
          scenes.push({ ...withKey, action: 'reuse_voiceover', reuseAssetId: reused });
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
        estimate: assessTtsCost({ characters: ttsCharacters(text), prices, reportedCost: null })
          .estimatedCost,
      });
    }
    return {
      item: { id: item.id, projectId: item.projectId, status: item.status },
      storyboardId: storyboard.id,
      modelId,
      modelKey: route.row.candidate.modelKey,
      voice: profile.snapshot,
      scenes,
    };
  }

  private async snapshot(voiceProfileId: string) {
    const p = await this.prisma.client.voiceProfile.findUniqueOrThrow({
      where: { id: voiceProfileId },
      include: { model: { select: { modelKey: true } } },
    });
    const snapshot: VoiceSnapshot = {
      voiceProfileId: p.id,
      voice: p.voice,
      language: p.language,
      speed: p.speed === null ? null : Number(p.speed),
      instructions: p.instructions,
    };
    return { snapshot, modelId: p.modelId, modelKey: p.model.modelKey, archived: !!p.archivedAt };
  }

  /** An approved, selected voice-over of this content item with the same hash. */
  private async reusableVoiceover(
    contentItemId: string,
    hash: string,
  ): Promise<string | undefined> {
    const rows = await this.prisma.client.$queryRaw<{ asset_id: string }[]>`
      SELECT v.asset_id FROM scene_voiceovers v JOIN assets a ON a.id = v.asset_id
      WHERE a.content_item_id = ${contentItemId}::uuid AND a.approval_status = 'approved'
        AND a.archived_at IS NULL AND a.metadata ->> 'voiceoverHash' = ${hash}
      ORDER BY v.selected_at DESC LIMIT 1`;
    return rows[0]?.asset_id;
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

function estimateDto(plan: Plan): VoiceoverEstimateDto {
  const generating = plan.scenes.filter((s) => s.action === 'generate');
  const unknownCost = generating.some((s) => s.estimate === null);
  return {
    modelKey: plan.modelKey,
    voiceProfileId: plan.voice.voiceProfileId,
    scenes: plan.scenes.map((s) => ({
      sceneId: s.scene.id,
      sceneNumber: s.scene.sceneNumber,
      action: s.action,
      characters: ttsCharacters(s.text),
      estimatedUsd:
        s.action !== 'generate' ? '0' : s.estimate === null ? null : s.estimate.toString(),
    })),
    totalEstimatedUsd: unknownCost
      ? null
      : UsdAmount.sum(generating.map((s) => s.estimate ?? UsdAmount.ZERO)).toString(),
    unknownCost,
  };
}
