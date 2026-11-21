// Scene clips, voice-overs and voice profiles over HTTP (M5 design §6–§7, §9.2, §11): plans and
// estimates, the confirmed-estimate guard and per-request budget, generation intent, selection (AC016),
// keyframe changes, "check again", cancel, and voice snapshots. The worker is not running: a
// finished job is simulated by inserting its result rows as the worker does (apps/worker covers
// the real path, including FFprobe validation).
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MockImageProvider,
  MockLlmProvider,
  MockTtsProvider,
  MockVideoProvider,
} from '@acf/ai-core/testing';
import { storageSettings } from '@acf/config';
import type {
  ImageGenerateResponseDto,
  ResumeRunResponseDto,
  StoryboardVideosDto,
  StoryboardVoiceoversDto,
  VideoEstimateDto,
  VideoGenerateResponseDto,
  VoiceoverEstimateDto,
  VoiceoverGenerateResponseDto,
  VoiceProfileDto,
  VoiceProfileListDto,
} from '@acf/contracts';
import type { Prisma, PrismaClient } from '@acf/database';
import { assetObjectKey, S3ObjectStore, sha256Hex, type ObjectStore } from '@acf/storage';
import { solidPng } from '@acf/storage/testing';

import { seedAiRegistry } from '../../src/cli/seed-ai.js';
import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import {
  actAs,
  addGenerationFixture,
  createFixture,
  seedUsers,
  signInAll,
  type Fixture,
  type GenerationFixture,
} from '../support/workspace.js';

let db: pg.Client;
let prisma: PrismaClient;
let ids: Record<string, string>;
let api: AuthTestApp;
let store: ObjectStore;
let as: ReturnType<typeof actAs>;

type World = Fixture & GenerationFixture;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test accessor
const bodyOf = <T>(res: { json: unknown }) => res.json as T;
const codeOf = (res: { json: unknown }) =>
  (res.json as { error?: { code?: string } } | null)?.error?.code;

const statusOf = async (contentId: string) =>
  (await prisma.contentItem.findUniqueOrThrow({ where: { id: contentId } })).status;

/** Supported durations of the seeded mock video model (the fixture scene lasts 30 s). */
async function setDurations(durations: number[], minBilledSeconds?: number): Promise<void> {
  const model = await prisma.aiModel.findFirstOrThrow({ where: { modelKey: 'mock/still-video' } });
  await prisma.aiModel.update({
    where: { id: model.id },
    data: {
      mediaConstraints: {
        kind: 'video',
        durations,
        resolutions: ['480p', '720p', '1080p'],
        aspectRatios: ['9:16', '1:1', '16:9'],
        frameImages: ['first_frame'],
        audio: false,
        seed: true,
        ...(minBilledSeconds === undefined ? {} : { minBilledSeconds }),
      },
    },
  });
}

async function approvedWorld(): Promise<World> {
  const base = await createFixture(db, ids);
  const w: World = { ...base, ...(await addGenerationFixture(db, ids, base)) };
  await db.query(
    `UPDATE content_items SET status = 'storyboard_review' WHERE id = '${w.contentId}'`,
  );
  expect((await as('editor', 'POST', `/storyboards/${w.storyboardId}/approve`)).status).toBe(200);
  return w;
}

/** Inserts the worker's result of a scene job: one generated asset, job succeeded. */
async function simulateSuccess(
  jobId: string,
  assetType: 'image' | 'video' | 'audio',
  metadata: Prisma.InputJsonObject = {},
  keyframeAssetId?: string,
): Promise<string> {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  const input = job.input as { sceneId: string };
  const assetId = randomUUID();
  const bytes = solidPng(9, 16, 3);
  const mimeType =
    assetType === 'image' ? 'image/png' : assetType === 'video' ? 'video/mp4' : 'audio/mpeg';
  const storageKey = assetObjectKey({
    projectId: job.projectId,
    assetId,
    sha256Hex: sha256Hex(bytes),
    mimeType,
  });
  // Keyframes are sent to the video provider: their bytes must exist.
  if (assetType === 'image') {
    await store.putIfAbsent(storageKey, bytes, {
      contentType: mimeType,
      sha256Hex: sha256Hex(bytes),
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 1, startedAt: new Date() },
    });
    await tx.asset.create({
      data: {
        id: assetId,
        projectId: job.projectId,
        contentItemId: job.contentItemId,
        assetType,
        sourceType: 'generated',
        generationJobId: jobId,
        storyboardSceneId: input.sceneId,
        storageKey,
        mimeType,
        sizeBytes: BigInt(bytes.byteLength),
        checksumSha256: sha256Hex(bytes),
        width: assetType === 'audio' ? null : 360,
        height: assetType === 'audio' ? null : 640,
        durationMs: assetType === 'image' ? null : 4000,
        metadata,
        createdById: job.requestedById,
      },
    });
    if (keyframeAssetId) {
      await tx.assetInput.create({
        data: {
          projectId: job.projectId,
          assetId,
          inputAssetId: keyframeAssetId,
          role: 'keyframe',
        },
      });
    }
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status: 'succeeded', activeKey: null, completedAt: new Date() },
    });
    await tx.productionRun.update({
      where: { id: job.productionRunId },
      data: { status: 'succeeded', completedAt: new Date() },
    });
    await tx.contentItem.update({
      where: { id: job.contentItemId },
      data: { status: 'asset_review' },
    });
  });
  return assetId;
}

/** Generates, approves and selects a keyframe for the world's scene. */
async function withKeyframe(w: World): Promise<string> {
  const job = bodyOf<ImageGenerateResponseDto>(
    await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, { body: {} }),
  ).jobs[0];
  const assetId = await simulateSuccess(job?.id ?? '', 'image');
  expect((await as('editor', 'POST', `/assets/${assetId}/approve`)).status).toBe(200);
  expect(
    (await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, { body: { assetId } })).status,
  ).toBe(200);
  return assetId;
}

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  api = await startAuthApp(
    {
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      QUEUE_PREFIX: `acf-media-${randomUUID().slice(0, 8)}`,
    },
    {
      llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]),
      imageProviders: new Map([['mock', new MockImageProvider({ providerKey: 'mock' })]]),
      videoProviders: new Map([['mock', new MockVideoProvider({ providerKey: 'mock' })]]),
      ttsProviders: new Map([['mock', new MockTtsProvider({ providerKey: 'mock' })]]),
    },
  );
  const settings = storageSettings(api.env);
  if (!settings) throw new Error('media API tests need object storage (S3_* variables)');
  store = new S3ObjectStore(settings);
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('clip plans and estimates', () => {
  it('skips scenes without a keyframe and those longer than every model duration', async () => {
    await setDurations([2, 4, 6, 8, 10]);
    const w = await approvedWorld();
    let estimate = bodyOf<VideoEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, { body: {} }),
    );
    expect(estimate).toMatchObject({
      modelKey: 'mock/still-video',
      resolution: '720p',
      generateAudio: false,
      totalEstimatedUsd: '0',
      unknownCost: false,
      requestBudgetUsd: '2',
      providerRetainsInputs: true,
    });
    expect(estimate.scenes).toEqual([
      {
        sceneId: w.sceneId,
        sceneNumber: 1,
        action: 'skip_no_keyframe',
        sceneSeconds: 30,
        requestedSeconds: null,
        billedSeconds: null,
        estimatedUsd: '0',
      },
    ]);

    await withKeyframe(w);
    estimate = bodyOf<VideoEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, { body: {} }),
    );
    expect(estimate.scenes[0]).toMatchObject({
      action: 'skip_exceeds_model_maximum',
      billedSeconds: null,
    });
  });

  it("bills at least the model's minimum billed seconds (benchmark: Kling)", async () => {
    await setDurations([5, 10, 30], 40);
    const w = await approvedWorld();
    await withKeyframe(w);
    const estimate = bodyOf<VideoEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, { body: {} }),
    );
    expect(estimate.scenes[0]).toMatchObject({
      action: 'generate',
      sceneSeconds: 30,
      requestedSeconds: 30,
      billedSeconds: 40,
    });
    await setDurations([5, 10, 30]);
  });

  it('refuses unsupported parameters and an unapproved storyboard', async () => {
    await setDurations([5, 10, 30]);
    const w = await approvedWorld();
    const res = await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, {
      body: { resolution: '4k' },
    });
    expect(res.status).toBe(400);
    const base = await createFixture(db, ids);
    const pending = await addGenerationFixture(db, ids, base);
    const notApproved = await as(
      'viewer',
      'POST',
      `/storyboards/${pending.storyboardId}/videos/estimate`,
      { body: {} },
    );
    expect([notApproved.status, codeOf(notApproved)]).toEqual([409, 'STORYBOARD_NOT_APPROVED']);
  });
});

describe('clip generation', () => {
  it('needs the confirmed estimate, then queues one job per scene from its keyframe', async () => {
    await setDurations([5, 10, 30]);
    const w = await approvedWorld();
    const keyframeId = await withKeyframe(w);

    const unconfirmed = await as(
      'editor',
      'POST',
      `/storyboards/${w.storyboardId}/videos/generate`,
      {
        body: {},
      },
    );
    expect([unconfirmed.status, codeOf(unconfirmed)]).toEqual([409, 'ESTIMATE_CHANGED']);

    const res = await as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
      body: { confirmedEstimateUsd: '0', seed: 5 },
    });
    expect(res.status).toBe(202);
    const body = bodyOf<VideoGenerateResponseDto>(res);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ kind: 'video_generation', status: 'queued' });
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: body.jobs[0]?.id ?? '' },
    });
    expect(job).toMatchObject({
      storyboardSceneId: w.sceneId,
      promptTemplateId: 'video.v1',
      activeKey: `${w.sceneId}:video_generation`,
    });
    expect(job.input).toMatchObject({
      keyframeAssetId: keyframeId,
      durationSeconds: 30,
      resolution: '720p',
      aspectRatio: '9:16',
      generateAudio: false,
      seed: 5,
      scene: { sceneNumber: 1, durationSeconds: 30, videoPrompt: 'Push in' },
    });
    expect(await statusOf(w.contentId)).toBe('generating_assets');

    // Not yet accepted by the provider: nothing to check.
    const recheck = await as('editor', 'POST', `/generation-jobs/${job.id}/recheck`);
    expect([recheck.status, codeOf(recheck)]).toEqual([409, 'JOB_NOT_RECHECKABLE']);

    const view = bodyOf<StoryboardVideosDto>(
      await as('viewer', 'GET', `/storyboards/${w.storyboardId}/videos`),
    );
    expect(view).toMatchObject({ approved: true, keyframesComplete: true, clipsComplete: false });
    expect(view.scenes[0]).toMatchObject({
      keyframe: { id: keyframeId },
      clip: null,
      activeJob: { id: job.id, status: 'queued' },
      progress: { providerStatus: null, pollCount: 0 },
    });
  });

  it('selects an approved clip, protects it, and clears it when the keyframe changes', async () => {
    await setDurations([5, 10, 30]);
    const w = await approvedWorld();
    const keyframeId = await withKeyframe(w);
    const job = bodyOf<VideoGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
        body: { confirmedEstimateUsd: '0' },
      }),
    ).jobs[0];
    const input = (await prisma.generationJob.findUniqueOrThrow({ where: { id: job?.id ?? '' } }))
      .input as { clipHash: string };
    const clipId = await simulateSuccess(
      job?.id ?? '',
      'video',
      { clipHash: input.clipHash },
      keyframeId,
    );

    const pending = await as('editor', 'PUT', `/scenes/${w.sceneId}/clip`, {
      body: { assetId: clipId },
    });
    expect([pending.status, codeOf(pending)]).toEqual([409, 'SCENE_SELECTION_INVALID']);
    expect((await as('editor', 'POST', `/assets/${clipId}/approve`)).status).toBe(200);
    const notClip = await as('editor', 'PUT', `/scenes/${w.sceneId}/clip`, {
      body: { assetId: keyframeId },
    });
    expect([notClip.status, codeOf(notClip)]).toEqual([409, 'CLIP_INVALID']);

    const view = bodyOf<StoryboardVideosDto>(
      await as('editor', 'PUT', `/scenes/${w.sceneId}/clip`, { body: { assetId: clipId } }),
    );
    expect(view.clipsComplete).toBe(true);
    expect(view.scenes[0]?.clip?.id).toBe(clipId);
    const reject = await as('editor', 'POST', `/assets/${clipId}/reject`);
    expect([reject.status, codeOf(reject)]).toEqual([409, 'SCENE_SELECTION_INVALID']);

    // Generating again skips the scene (it has a clip); identical inputs would reuse it.
    const again = bodyOf<VideoEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, { body: {} }),
    );
    expect(again.scenes[0]?.action).toBe('skip_has_clip');

    // A new keyframe: the clip no longer starts from it.
    const image = bodyOf<ImageGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, {
        body: { sceneIds: [w.sceneId], regenerate: true },
      }),
    ).jobs[0];
    const second = await simulateSuccess(image?.id ?? '', 'image');
    await as('editor', 'POST', `/assets/${second}/approve`);
    await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, { body: { assetId: second } });
    const after = bodyOf<StoryboardVideosDto>(
      await as('viewer', 'GET', `/storyboards/${w.storyboardId}/videos`),
    );
    expect(after.scenes[0]?.clip).toBeNull();
    expect(after.clipsComplete).toBe(false);
    const events = await prisma.sceneClipEvent.findMany({
      where: { storyboardSceneId: w.sceneId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.reason)).toEqual(['selected', 'cleared']);
  });

  it('checks a running video job again, and cancel records an unknown outcome', async () => {
    await setDurations([5, 10, 30]);
    const w = await approvedWorld();
    await withKeyframe(w);
    const queued = bodyOf<VideoGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
        body: { confirmedEstimateUsd: '0' },
      }),
    ).jobs[0];
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: queued?.id ?? '' } });
    // What the worker records once the provider accepted the submission.
    const invocation = await prisma.aiInvocation.create({
      data: {
        projectId: job.projectId,
        contentItemId: job.contentItemId,
        generationJobId: job.id,
        correlationId: job.id,
        capability: 'video_generation',
        providerId: (await prisma.aiProvider.findUniqueOrThrow({ where: { key: 'mock' } })).id,
        modelId: job.modelId,
        requestSummary: {},
      },
    });
    await prisma.generationJob.update({
      where: { id: job.id },
      data: {
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
        submittedAt: new Date(),
        invocationId: invocation.id,
        providerKey: 'mock',
        providerJobId: `mock-vid-${randomUUID()}`,
        providerStatus: 'in_progress',
        pollCount: 3,
      },
    });
    const viewer = await as('viewer', 'POST', `/generation-jobs/${job.id}/recheck`);
    expect(viewer.status).toBe(403);
    const recheck = await as('editor', 'POST', `/generation-jobs/${job.id}/recheck`);
    expect(recheck.status).toBe(202);
    const view = bodyOf<StoryboardVideosDto>(
      await as('viewer', 'GET', `/storyboards/${w.storyboardId}/videos`),
    );
    expect(view.scenes[0]?.progress).toMatchObject({ providerStatus: 'in_progress', pollCount: 3 });

    const cancel = await as('editor', 'POST', `/production-runs/${job.productionRunId}/cancel`);
    expect(cancel.status).toBe(200);
    expect(
      await prisma.aiInvocation.findUniqueOrThrow({ where: { id: invocation.id } }),
    ).toMatchObject({ status: 'outcome_unknown', errorCode: 'CANCELED_BY_USER' });
    expect(await statusOf(w.contentId)).toBe('asset_review');
  });
});

describe('voice profiles and voice-overs', () => {
  it('manages voice profiles and validates the voice against the model', async () => {
    const w = await approvedWorld();
    const bad = await as('editor', 'POST', `/projects/${w.projectId}/voice-profiles`, {
      body: { name: 'N', modelKey: 'mock/tone-tts', voice: 'nobody', language: 'vi' },
    });
    expect([bad.status, codeOf(bad)]).toEqual([422, 'MODEL_LIMITS']);
    const created = await as('editor', 'POST', `/projects/${w.projectId}/voice-profiles`, {
      body: {
        name: 'Narrator',
        modelKey: 'mock/tone-tts',
        voice: 'mock-a',
        language: 'vi-VN',
        speed: 1.1,
      },
    });
    expect(created.status).toBe(201);
    const profile = bodyOf<VoiceProfileDto>(created);
    expect(profile).toMatchObject({ modelKey: 'mock/tone-tts', speed: 1.1, instructions: null });
    const edited = bodyOf<VoiceProfileDto>(
      await as('editor', 'PATCH', `/voice-profiles/${profile.id}`, { body: { voice: 'mock-b' } }),
    );
    expect(edited.voice).toBe('mock-b');
    expect(
      (await as('viewer', 'PATCH', `/voice-profiles/${profile.id}`, { body: { name: 'x' } }))
        .status,
    ).toBe(403);
    await as('editor', 'POST', `/voice-profiles/${profile.id}/archive`);
    const list = bodyOf<VoiceProfileListDto>(
      await as('viewer', 'GET', `/projects/${w.projectId}/voice-profiles`),
    );
    expect(list.items).toEqual([]);
    const all = bodyOf<VoiceProfileListDto>(
      await as('viewer', 'GET', `/projects/${w.projectId}/voice-profiles?includeArchived=true`),
    );
    expect(all.items.map((p) => p.id)).toEqual([profile.id]);
    const useArchived = await as('editor', 'PATCH', `/content/${w.contentId}`, {
      body: { voiceProfileId: profile.id },
    });
    expect(useArchived.status).toBe(422);
  });

  it('needs a voice profile, snapshots it into the job, and selects generated or imported audio', async () => {
    const w = await approvedWorld();
    const none = await as('viewer', 'POST', `/storyboards/${w.storyboardId}/voiceovers/estimate`, {
      body: {},
    });
    expect([none.status, codeOf(none)]).toEqual([409, 'VOICE_PROFILE_REQUIRED']);

    const profile = bodyOf<VoiceProfileDto>(
      await as('editor', 'POST', `/projects/${w.projectId}/voice-profiles`, {
        body: { name: 'Narrator', modelKey: 'mock/tone-tts', voice: 'mock-a', language: 'vi' },
      }),
    );
    const patched = await as('editor', 'PATCH', `/content/${w.contentId}`, {
      body: { voiceProfileId: profile.id },
    });
    expect(patched.status).toBe(200);
    expect((patched.json as { voiceProfileId: string }).voiceProfileId).toBe(profile.id);

    const estimate = bodyOf<VoiceoverEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/voiceovers/estimate`, {
        body: {},
      }),
    );
    expect(estimate).toMatchObject({
      modelKey: 'mock/tone-tts',
      voiceProfileId: profile.id,
      scenes: [{ sceneId: w.sceneId, action: 'generate', characters: 5 }],
      unknownCost: false,
    });
    const generated = bodyOf<VoiceoverGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/voiceovers/generate`, {
        body: {},
      }),
    );
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: generated.jobs[0]?.id ?? '' },
    });
    expect(job).toMatchObject({ kind: 'tts_generation', promptTemplateId: 'tts.v1' });
    const input = job.input as { voiceoverHash: string };
    expect(job.input).toMatchObject({
      text: 'Hello',
      sceneDurationSeconds: 30,
      voice: { voiceProfileId: profile.id, voice: 'mock-a', language: 'vi', speed: null },
    });
    // Editing the profile later does not change the queued job.
    await as('editor', 'PATCH', `/voice-profiles/${profile.id}`, { body: { voice: 'mock-b' } });
    expect(
      (await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).input,
    ).toMatchObject({ voice: { voice: 'mock-a' } });

    const audioId = await simulateSuccess(job.id, 'audio', {
      purpose: 'voiceover',
      voiceoverHash: input.voiceoverHash,
    });
    // Imported narration of the project (V8) is also a candidate.
    const upload = randomUUID();
    await prisma.asset.create({
      data: {
        id: upload,
        projectId: w.projectId,
        assetType: 'audio',
        sourceType: 'upload',
        storageKey: `projects/${w.projectId}/assets/${upload}/x.mp3`,
        mimeType: 'audio/mpeg',
        sizeBytes: 10n,
        checksumSha256: 'c'.repeat(64),
        durationMs: 40_000,
        metadata: { purpose: 'voiceover' },
        createdById: ids['owner'] ?? '',
      },
    });
    let view = bodyOf<StoryboardVoiceoversDto>(
      await as('viewer', 'GET', `/storyboards/${w.storyboardId}/voiceovers`),
    );
    expect(view).toMatchObject({ voiceProfileId: profile.id, voiceoversComplete: false });
    expect(view.scenes[0]?.candidates.map((c) => c.id)).toEqual([audioId, upload]);

    await as('editor', 'POST', `/assets/${audioId}/approve`);
    view = bodyOf<StoryboardVoiceoversDto>(
      await as('editor', 'PUT', `/scenes/${w.sceneId}/voiceover`, { body: { assetId: audioId } }),
    );
    expect(view).toMatchObject({ voiceoversComplete: true });
    expect(view.scenes[0]).toMatchObject({ voiceover: { id: audioId }, exceedsScene: false });

    // The imported narration lasts 40 s: longer than the 30 s scene.
    await as('editor', 'POST', `/assets/${upload}/approve`);
    view = bodyOf<StoryboardVoiceoversDto>(
      await as('editor', 'PUT', `/scenes/${w.sceneId}/voiceover`, { body: { assetId: upload } }),
    );
    expect(view.scenes[0]).toMatchObject({ voiceover: { id: upload }, exceedsScene: true });
  });
});

// Last: prices are append-only and shared by every test of this file.
describe('per-request budget (decisions V10, B5)', () => {
  it('refuses a request whose estimate is above the per-request budget, or above the confirmed one', async () => {
    await setDurations([5, 10, 30]);
    const model = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'mock/still-video' },
    });
    await prisma.aiModelPrice.create({
      data: {
        modelId: model.id,
        metric: 'output_video_seconds',
        unitPrice: '0.5',
        sourceValue: '0.5',
        effectiveFrom: new Date(Date.now() - 1000),
        source: 'manual_estimate',
        sourceUrl: 'urn:acf:test',
        capturedAt: new Date(),
      },
    });
    const w = await approvedWorld();
    await withKeyframe(w);
    const estimate = bodyOf<VideoEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/videos/estimate`, { body: {} }),
    );
    expect(estimate).toMatchObject({ totalEstimatedUsd: '15', unknownCost: false });
    expect(estimate.scenes[0]).toMatchObject({ billedSeconds: 30, estimatedUsd: '15' });

    const stale = await as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
      body: { confirmedEstimateUsd: '1' },
    });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'ESTIMATE_CHANGED']);
    const guarded = await as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
      body: { confirmedEstimateUsd: '15' },
    });
    expect([guarded.status, codeOf(guarded)]).toEqual([402, 'BUDGET_EXCEEDED']);
    expect(
      await prisma.budgetReservation.count({
        where: { contentItemId: w.contentId, job: { kind: 'video_generation' } },
      }),
    ).toBe(0);
    expect(
      await prisma.generationJob.count({
        where: { kind: 'video_generation', contentItemId: w.contentId },
      }),
    ).toBe(0);
  });
});

describe('delivered output (P3d R3, R7)', () => {
  /** A clip job that was delivered and stored, then failed because FFprobe was missing. */
  async function deliveredClipJob(
    w: World,
    errorCode = 'MEDIA_TOOLS_MISSING',
  ): Promise<{ jobId: string; runId: string; bytes: Uint8Array; assetId: string }> {
    const model = await prisma.aiModel.findFirstOrThrow({
      where: { mediaConstraints: { path: ['kind'], equals: 'video' }, provider: { key: 'mock' } },
    });
    const run = await prisma.productionRun.create({
      data: {
        projectId: w.projectId,
        contentItemId: w.contentId,
        requestedById: ids['editor'] ?? '',
      },
    });
    const job = await prisma.generationJob.create({
      data: {
        projectId: w.projectId,
        contentItemId: w.contentId,
        productionRunId: run.id,
        kind: 'video_generation',
        storyboardSceneId: w.sceneId,
        activeKey: `${w.sceneId}:video_generation`,
        idempotencyKey: `p3d-${run.id}`,
        executionKey: 'f'.repeat(64),
        input: { sceneId: w.sceneId },
        previousContentStatus: 'asset_review',
        promptTemplateId: 'video.v1',
        modelId: model.id,
        requestedById: ids['editor'] ?? '',
      },
    });
    const bytes = new Uint8Array([
      0,
      0,
      0,
      24,
      ...new TextEncoder().encode('ftypisom'),
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
    ]);
    const assetId = randomUUID();
    const digest = sha256Hex(bytes);
    const key = assetObjectKey({
      projectId: job.projectId,
      assetId,
      sha256Hex: digest,
      mimeType: 'video/mp4',
    });
    await store.putIfAbsent(key, bytes, { contentType: 'video/mp4', sha256Hex: digest });
    await db.query(`BEGIN;
      UPDATE generation_jobs SET status = 'running', attempt = 1, started_at = now() WHERE id = '${job.id}';
      UPDATE generation_jobs SET delivered_at = now(), staged_asset_id = '${assetId}',
        staged_object_key = '${key}', staged_sha256 = '${digest}', staged_mime_type = 'video/mp4'
        WHERE id = '${job.id}';
      UPDATE generation_jobs SET status = 'failed', active_key = NULL, completed_at = now(),
        error_code = '${errorCode}', error_message = 'x' WHERE id = '${job.id}';
      UPDATE production_runs SET status = 'failed', completed_at = now() WHERE id = '${job.productionRunId}';
      UPDATE content_items SET status = 'asset_review' WHERE id = '${w.contentId}';
      COMMIT;`);
    return { jobId: job.id, runId: job.productionRunId, bytes, assetId };
  }

  it('previews the delivered file and finishes it without a new charge, once', async () => {
    const w = await approvedWorld();
    const d = await deliveredClipJob(w);

    const detail = await as('viewer', 'GET', `/generation-jobs/${d.jobId}`);
    expect(detail.json).toMatchObject({
      hasDeliveredOutput: true,
      finishable: true,
      recoverFromJobId: null,
    });

    const preview = await as('viewer', 'GET', `/generation-jobs/${d.jobId}/delivered-output`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('video/mp4');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(preview.bytes).equals(Buffer.from(d.bytes))).toBe(true);
    const part = await as('viewer', 'GET', `/generation-jobs/${d.jobId}/delivered-output`, {
      headers: { range: 'bytes=0-3' },
    });
    expect(part.status).toBe(206);
    expect(part.bytes.byteLength).toBe(4);
    expect(
      (await as('outsider', 'GET', `/generation-jobs/${d.jobId}/delivered-output`)).status,
    ).toBe(404);

    const res = await as('editor', 'POST', `/production-runs/${d.runId}/resume`, { body: {} });
    expect(res.status).toBe(202);
    const resumed = bodyOf<ResumeRunResponseDto>(res);
    expect(resumed.skipped).toEqual([
      { jobId: d.jobId, sceneId: w.sceneId, reason: 'finished_without_charge' },
    ]);
    const finish = resumed.run?.jobs[0];
    expect(finish).toMatchObject({
      kind: 'video_generation',
      status: 'queued',
      recoverFromJobId: d.jobId,
    });
    // It never calls a provider: nothing is reserved.
    expect(await prisma.budgetReservation.count({ where: { jobId: finish?.id ?? '' } })).toBe(0);

    const again = await as('editor', 'POST', `/production-runs/${d.runId}/resume`, { body: {} });
    expect([again.status, codeOf(again)]).toEqual([409, 'NOTHING_TO_RESUME']);

    // Once finished into an asset, the delivered file is the asset.
    await simulateSuccessWithId(finish?.id ?? '', d.assetId);
    const gone = await as('viewer', 'GET', `/generation-jobs/${d.jobId}/delivered-output`);
    expect([gone.status, codeOf(gone)]).toEqual([410, 'ALREADY_FINISHED']);
  });

  it('checks a stored clip refused by validation again, without a new charge (P3d rev. 2)', async () => {
    const w = await approvedWorld();
    const d = await deliveredClipJob(w, 'OUTPUT_INVALID');
    expect((await as('viewer', 'GET', `/generation-jobs/${d.jobId}`)).json).toMatchObject({
      finishable: true,
    });
    const res = await as('editor', 'POST', `/production-runs/${d.runId}/resume`, { body: {} });
    expect(res.status).toBe(202);
    const resumed = bodyOf<ResumeRunResponseDto>(res);
    expect(resumed.skipped).toEqual([
      { jobId: d.jobId, sceneId: w.sceneId, reason: 'finished_without_charge' },
    ]);
    const finish = resumed.run?.jobs[0];
    expect(finish).toMatchObject({ recoverFromJobId: d.jobId, status: 'queued' });
    expect(await prisma.budgetReservation.count({ where: { jobId: finish?.id ?? '' } })).toBe(0);
  });

  it('answers 404 for a job without a delivered file', async () => {
    const w = await approvedWorld();
    const res = await as('viewer', 'GET', `/generation-jobs/${w.jobId}/delivered-output`);
    expect(res.status).toBe(404);
  });
});

/** Creates the asset a finish job would (with the reserved id) and ends the job. */
async function simulateSuccessWithId(jobId: string, assetId: string): Promise<void> {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  const paid = await prisma.generationJob.findUniqueOrThrow({
    where: { id: job.recoverFromJobId ?? '' },
  });
  await prisma.$transaction(async (tx) => {
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 1, startedAt: new Date() },
    });
    await tx.asset.create({
      data: {
        id: assetId,
        projectId: job.projectId,
        contentItemId: job.contentItemId,
        assetType: 'video',
        sourceType: 'generated',
        generationJobId: paid.id,
        storyboardSceneId: job.storyboardSceneId,
        storageKey: paid.stagedObjectKey ?? '',
        mimeType: 'video/mp4',
        sizeBytes: 24n,
        checksumSha256: paid.stagedSha256 ?? '',
        width: 360,
        height: 640,
        durationMs: 4000,
        createdById: job.requestedById,
      },
    });
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status: 'succeeded', activeKey: null, completedAt: new Date() },
    });
  });
}

describe('image listing shows image jobs only (UX review D1)', () => {
  it('ignores the clip and voice-over jobs of the same scene', async () => {
    const w = await approvedWorld();
    await withKeyframe(w);
    const model = await prisma.aiModel.findFirstOrThrow({
      where: { mediaConstraints: { path: ['kind'], equals: 'video' }, provider: { key: 'mock' } },
    });
    const run = await prisma.productionRun.create({
      data: {
        projectId: w.projectId,
        contentItemId: w.contentId,
        requestedById: ids['editor'] ?? '',
      },
    });
    await prisma.generationJob.create({
      data: {
        projectId: w.projectId,
        contentItemId: w.contentId,
        productionRunId: run.id,
        kind: 'video_generation',
        storyboardSceneId: w.sceneId,
        activeKey: `${w.sceneId}:video_generation`,
        idempotencyKey: `d1-${run.id}`,
        executionKey: 'd'.repeat(64),
        input: { sceneId: w.sceneId },
        previousContentStatus: 'asset_review',
        promptTemplateId: 'video.v1',
        modelId: model.id,
        requestedById: ids['editor'] ?? '',
      },
    });
    const res = await as('viewer', 'GET', `/storyboards/${w.storyboardId}/images`);
    expect(res.status).toBe(200);
    const scenes = (
      res.json as { scenes: { lastJob: { kind: string } | null; activeJob: unknown }[] }
    ).scenes;
    expect(scenes[0]?.lastJob?.kind).toBe('image_generation');
    expect(scenes[0]?.activeJob).toBeNull();
  });
});

describe('voice-over off for a content item (P4d)', () => {
  it('refuses voice-over estimates and generation, and renders need no voice-over', async () => {
    const w = await approvedWorld();
    const patch = await as('editor', 'PATCH', `/content/${w.contentId}`, {
      body: { voiceEnabled: false },
    });
    expect(patch.status).toBe(200);
    expect(patch.json).toMatchObject({ voiceEnabled: false });

    for (const path of ['estimate', 'generate']) {
      const res = await as('editor', 'POST', `/storyboards/${w.storyboardId}/voiceovers/${path}`, {
        body: {},
      });
      expect([res.status, codeOf(res)]).toEqual([409, 'VOICE_DISABLED']);
    }
    const plan = await as('viewer', 'GET', `/content/${w.contentId}/render-plan`);
    expect(plan.status).toBe(200);
    const codes = (plan.json as { blockers: { code: string }[] }).blockers.map((b) => b.code);
    expect(codes).not.toContain('VOICEOVERS_INCOMPLETE');

    expect(
      (await as('editor', 'PATCH', `/content/${w.contentId}`, { body: { voiceEnabled: true } }))
        .json,
    ).toMatchObject({ voiceEnabled: true });
  });
});
