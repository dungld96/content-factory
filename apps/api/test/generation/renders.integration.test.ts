// Renders over HTTP (M6 design §4–§11): preflight blockers, render intent and reuse, music
// validation, gate 5 (approve/reject), export, the package manifest and the cost report. The
// worker is not running: a finished render is simulated by writing its outputs as the worker does
// (apps/worker covers the real FFmpeg path).
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
  CostReportDto,
  CreateRenderResponseDto,
  ImageGenerateResponseDto,
  RenderDto,
  RenderListDto,
  RenderManifestDocumentDto,
  RenderPlanDto,
  VideoGenerateResponseDto,
  VoiceoverGenerateResponseDto,
  VoiceProfileDto,
} from '@acf/contracts';
import type { PrismaClient } from '@acf/database';
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

/** A stored file (bytes are not decoded by the API; the worker tests use real media). */
async function stored(
  projectId: string,
  assetId: string,
  mimeType: 'image/png' | 'video/mp4' | 'audio/mpeg',
) {
  const bytes = solidPng(9, 16, 3);
  const storageKey = assetObjectKey({ projectId, assetId, sha256Hex: sha256Hex(bytes), mimeType });
  await store.putIfAbsent(storageKey, bytes, {
    contentType: mimeType,
    sha256Hex: sha256Hex(bytes),
  });
  return { storageKey, sizeBytes: BigInt(bytes.byteLength), checksumSha256: sha256Hex(bytes) };
}

/** What the worker records when a scene job succeeds: one generated asset with a stored file. */
async function simulateSceneJob(
  jobId: string,
  assetType: 'image' | 'video' | 'audio',
  durationMs: number | null = null,
): Promise<string> {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  const input = job.input as { sceneId: string };
  const assetId = randomUUID();
  const mimeType =
    assetType === 'image' ? 'image/png' : assetType === 'video' ? 'video/mp4' : 'audio/mpeg';
  const file = await stored(job.projectId, assetId, mimeType);
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
        mimeType,
        ...file,
        width: assetType === 'audio' ? null : 720,
        height: assetType === 'audio' ? null : 1280,
        durationMs,
        createdById: job.requestedById,
      },
    });
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

async function setDurations(durations: number[]): Promise<void> {
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
      },
    },
  });
}

/** Approved storyboard (one 30 s scene with narration "Hello"). */
async function approvedWorld(): Promise<World> {
  const base = await createFixture(db, ids);
  const w: World = { ...base, ...(await addGenerationFixture(db, ids, base)) };
  await db.query(
    `UPDATE content_items SET status = 'storyboard_review' WHERE id = '${w.contentId}'`,
  );
  expect((await as('editor', 'POST', `/storyboards/${w.storyboardId}/approve`)).status).toBe(200);
  return w;
}

/** Keyframe, clip and voice-over chosen for the scene (gate 4), as the M5 flow produces them. */
async function readyWorld(voiceMs = 4000): Promise<World & { clipId: string; voiceId: string }> {
  const w = await approvedWorld();
  const image = bodyOf<ImageGenerateResponseDto>(
    await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, { body: {} }),
  ).jobs[0];
  const keyframe = await simulateSceneJob(image?.id ?? '', 'image');
  await as('editor', 'POST', `/assets/${keyframe}/approve`);
  await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, { body: { assetId: keyframe } });

  const video = bodyOf<VideoGenerateResponseDto>(
    await as('editor', 'POST', `/storyboards/${w.storyboardId}/videos/generate`, {
      body: { confirmedEstimateUsd: '0' },
    }),
  ).jobs[0];
  const clipId = await simulateSceneJob(video?.id ?? '', 'video', 30_000);
  await as('editor', 'POST', `/assets/${clipId}/approve`);
  expect(
    (await as('editor', 'PUT', `/scenes/${w.sceneId}/clip`, { body: { assetId: clipId } })).status,
  ).toBe(200);

  const profile = bodyOf<VoiceProfileDto>(
    await as('editor', 'POST', `/projects/${w.projectId}/voice-profiles`, {
      body: { name: 'Narrator', modelKey: 'mock/tone-tts', voice: 'mock-a', language: 'vi' },
    }),
  );
  await as('editor', 'PATCH', `/content/${w.contentId}`, { body: { voiceProfileId: profile.id } });
  const tts = bodyOf<VoiceoverGenerateResponseDto>(
    await as('editor', 'POST', `/storyboards/${w.storyboardId}/voiceovers/generate`, { body: {} }),
  ).jobs[0];
  const voiceId = await simulateSceneJob(tts?.id ?? '', 'audio', voiceMs);
  await as('editor', 'POST', `/assets/${voiceId}/approve`);
  expect(
    (await as('editor', 'PUT', `/scenes/${w.sceneId}/voiceover`, { body: { assetId: voiceId } }))
      .status,
  ).toBe(200);
  return { ...w, clipId, voiceId };
}

/** What the worker records when a render succeeds (outputs, QC, job, status). */
async function simulateRender(renderId: string): Promise<void> {
  const render = await prisma.render.findUniqueOrThrow({
    where: { id: renderId },
    include: { generationJob: true },
  });
  const job = render.generationJob;
  const out = async (type: 'render' | 'subtitle' | 'image', mime: 'video/mp4' | 'image/png') => {
    const id = randomUUID();
    await prisma.asset.create({
      data: {
        id,
        projectId: render.projectId,
        contentItemId: render.contentItemId,
        assetType: type,
        sourceType: 'generated',
        generationJobId: job.id,
        mimeType: type === 'subtitle' ? 'application/x-subrip' : mime,
        ...(await stored(render.projectId, id, mime)),
        createdById: job.requestedById,
      },
    });
    return id;
  };
  await prisma.generationJob.update({
    where: { id: job.id },
    data: { status: 'running', attempt: 1, startedAt: new Date() },
  });
  const [video, srt, thumb] = [
    await out('render', 'video/mp4'),
    await out('subtitle', 'video/mp4'),
    await out('image', 'image/png'),
  ];
  await prisma.$transaction(async (tx) => {
    await tx.render.update({
      where: { id: renderId },
      data: {
        videoAssetId: video,
        subtitleAssetId: srt,
        thumbnailAssetId: thumb,
        durationMs: 30_000,
        qc: {
          passed: true,
          findings: [],
          measured: {
            width: 1080,
            height: 1920,
            fps: 30,
            durationMs: 30_000,
            videoCodec: 'h264',
            audioCodec: 'aac',
            integratedLufs: -14,
            truePeakDb: -1.2,
          },
          ffmpeg: 'ffmpeg version test',
          elapsedMs: 1000,
        },
      },
    });
    await tx.generationJob.update({
      where: { id: job.id },
      data: { status: 'succeeded', activeKey: null, completedAt: new Date() },
    });
    await tx.contentItem.update({
      where: { id: render.contentItemId },
      data: { status: 'quality_review' },
    });
  });
}

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  await setDurations([5, 10, 30]);
  api = await startAuthApp(
    {
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      QUEUE_PREFIX: `acf-render-${randomUUID().slice(0, 8)}`,
    },
    {
      llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]),
      imageProviders: new Map([['mock', new MockImageProvider({ providerKey: 'mock' })]]),
      videoProviders: new Map([['mock', new MockVideoProvider({ providerKey: 'mock' })]]),
      ttsProviders: new Map([['mock', new MockTtsProvider({ providerKey: 'mock' })]]),
    },
  );
  const settings = storageSettings(api.env);
  if (!settings) throw new Error('render API tests need object storage (S3_* variables)');
  store = new S3ObjectStore(settings);
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('preflight', () => {
  it('lists what is missing before a render can start', async () => {
    const w = await approvedWorld();
    const plan = bodyOf<RenderPlanDto>(
      await as('viewer', 'GET', `/content/${w.contentId}/render-plan`),
    );
    expect(plan).toMatchObject({
      storyboardVersionId: w.storyboardId,
      totalSeconds: 30,
      renderInProgress: false,
    });
    expect(plan.blockers.map((b) => [b.code, b.sceneNumber])).toEqual([
      ['CLIPS_INCOMPLETE', 1],
      ['VOICEOVERS_INCOMPLETE', 1],
    ]);
    const res = await as('editor', 'POST', `/content/${w.contentId}/renders`, { body: {} });
    expect([res.status, codeOf(res)]).toEqual([409, 'CLIPS_INCOMPLETE']);
  });

  it('blocks a voice-over longer than its scene (X6)', async () => {
    const w = await readyWorld(31_000);
    const plan = bodyOf<RenderPlanDto>(
      await as('viewer', 'GET', `/content/${w.contentId}/render-plan`),
    );
    expect(plan.blockers.map((b) => b.code)).toEqual(['VOICEOVER_EXCEEDS_SCENE']);
    expect(plan.blockers[0]?.message).toContain('31.0 s');
  });
});

describe('render, review and export', () => {
  it('queues a render with a frozen manifest, reuses it, and refuses a second active render', async () => {
    const w = await readyWorld();
    const plan = bodyOf<RenderPlanDto>(
      await as('viewer', 'GET', `/content/${w.contentId}/render-plan`),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.upscaledFrom).toBe('720p');
    expect(
      (await as('viewer', 'POST', `/content/${w.contentId}/renders`, { body: {} })).status,
    ).toBe(403);

    const res = await as('editor', 'POST', `/content/${w.contentId}/renders`, {
      body: { captions: { burnIn: true } },
    });
    expect(res.status).toBe(202);
    const created = bodyOf<CreateRenderResponseDto>(res);
    expect(created.reused).toBe(false);
    expect(created.render).toMatchObject({
      status: 'queued',
      burnInCaptions: true,
      upscaledFrom: '720p',
      reviewStatus: 'pending',
      isApproved: false,
      job: { kind: 'render', modelKey: 'local/ffmpeg-render' },
    });
    const row = await prisma.render.findUniqueOrThrow({ where: { id: created.render.id } });
    expect(row.manifest).toMatchObject({
      storyboardVersionId: w.storyboardId,
      scenes: [
        {
          sceneNumber: 1,
          durationMs: 30_000,
          clipAssetId: w.clipId,
          voiceoverAssetId: w.voiceId,
          text: 'Hello',
        },
      ],
      music: null,
    });
    expect(await statusOf(w.contentId)).toBe('rendering');

    const again = bodyOf<CreateRenderResponseDto>(
      await as('editor', 'POST', `/content/${w.contentId}/renders`, {
        body: { captions: { burnIn: true } },
      }),
    );
    expect(again).toMatchObject({ reused: true, render: { id: created.render.id } });
    const busy = await as('editor', 'POST', `/content/${w.contentId}/renders`, {
      body: { regenerate: true },
    });
    expect([busy.status, codeOf(busy)]).toEqual([409, 'RENDER_IN_PROGRESS']);
  });

  it('approves (gate 5), exports, and serves the manifest and cost report', async () => {
    const w = await readyWorld();
    const { render } = bodyOf<CreateRenderResponseDto>(
      await as('editor', 'POST', `/content/${w.contentId}/renders`, { body: {} }),
    );
    const early = await as('editor', 'POST', `/renders/${render.id}/approve`, { body: {} });
    expect([early.status, codeOf(early)]).toEqual([409, 'RENDER_NOT_REVIEWABLE']);
    await simulateRender(render.id);
    expect(await statusOf(w.contentId)).toBe('quality_review');

    const notYet = await as('editor', 'POST', `/renders/${render.id}/export`);
    expect([notYet.status, codeOf(notYet)]).toEqual([409, 'RENDER_NOT_APPROVED']);
    expect((await as('viewer', 'POST', `/renders/${render.id}/approve`, { body: {} })).status).toBe(
      403,
    );
    const approved = bodyOf<RenderDto>(
      await as('editor', 'POST', `/renders/${render.id}/approve`, {
        body: { note: 'Looks right' },
      }),
    );
    expect(approved).toMatchObject({
      status: 'succeeded',
      reviewStatus: 'approved',
      isApproved: true,
      reviewNote: 'Looks right',
    });
    expect(approved.video).toMatchObject({ assetType: 'render' });
    expect(approved.qc).toMatchObject({ passed: true, measured: { integratedLufs: -14 } });
    expect(await statusOf(w.contentId)).toBe('approved');
    const twice = await as('editor', 'POST', `/renders/${render.id}/approve`, { body: {} });
    expect([twice.status, codeOf(twice)]).toEqual([409, 'RENDER_NOT_REVIEWABLE']);

    const exported = bodyOf<RenderDto>(await as('editor', 'POST', `/renders/${render.id}/export`));
    expect(exported.exportedAt).not.toBeNull();
    expect(await statusOf(w.contentId)).toBe('exported');
    expect(
      bodyOf<RenderDto>(await as('editor', 'POST', `/renders/${render.id}/export`)).exportedAt,
    ).toBe(exported.exportedAt);

    const manifest = bodyOf<RenderManifestDocumentDto>(
      await as('viewer', 'GET', `/renders/${render.id}/manifest`),
    );
    expect(manifest.outputs.map((o) => o.role)).toEqual(['video', 'subtitles', 'thumbnail']);
    expect(manifest.review.status).toBe('approved');
    expect(manifest.script).toMatchObject({ version: 1 });
    const cost = bodyOf<CostReportDto>(
      await as('viewer', 'GET', `/renders/${render.id}/cost-report`),
    );
    expect(cost).toMatchObject({
      currency: 'USD',
      renderCostUsd: '0',
      total: { calls: 0, unknownCalls: 0 },
    });

    const list = bodyOf<RenderListDto>(
      await as('viewer', 'GET', `/content/${w.contentId}/renders`),
    );
    expect(list.items.map((r) => [r.id, r.isApproved])).toEqual([[render.id, true]]);
  });

  it('rejects with a note back to asset review', async () => {
    const w = await readyWorld();
    const { render } = bodyOf<CreateRenderResponseDto>(
      await as('editor', 'POST', `/content/${w.contentId}/renders`, { body: {} }),
    );
    await simulateRender(render.id);
    expect((await as('editor', 'POST', `/renders/${render.id}/reject`, { body: {} })).status).toBe(
      400,
    );
    const rejected = bodyOf<RenderDto>(
      await as('editor', 'POST', `/renders/${render.id}/reject`, {
        body: { note: 'Scene 1 is too dark' },
      }),
    );
    expect(rejected).toMatchObject({
      reviewStatus: 'rejected',
      reviewNote: 'Scene 1 is too dark',
      isApproved: false,
    });
    expect(await statusOf(w.contentId)).toBe('asset_review');
  });

  it('accepts only an approved music upload, recording its licence note', async () => {
    const w = await readyWorld();
    const bad = await as('editor', 'POST', `/content/${w.contentId}/renders`, {
      body: { music: { assetId: w.voiceId } },
    });
    expect([bad.status, codeOf(bad)]).toEqual([422, 'MUSIC_INVALID']);
    const musicId = randomUUID();
    await prisma.asset.create({
      data: {
        id: musicId,
        projectId: w.projectId,
        assetType: 'audio',
        sourceType: 'upload',
        mimeType: 'audio/mpeg',
        ...(await stored(w.projectId, musicId, 'audio/mpeg')),
        sourceNote: 'CC BY 4.0, Artist X',
        metadata: { purpose: 'music' },
        approvalStatus: 'approved',
        reviewedById: ids['owner'] ?? '',
        reviewedAt: new Date(),
        createdById: ids['owner'] ?? '',
      },
    });
    const plan = bodyOf<RenderPlanDto>(
      await as('viewer', 'GET', `/content/${w.contentId}/render-plan`),
    );
    expect(plan.musicOptions.map((m) => m.id)).toEqual([musicId]);
    const { render } = bodyOf<CreateRenderResponseDto>(
      await as('editor', 'POST', `/content/${w.contentId}/renders`, {
        body: { music: { assetId: musicId } },
      }),
    );
    expect(render.musicAssetId).toBe(musicId);
    expect(
      (await prisma.render.findUniqueOrThrow({ where: { id: render.id } })).manifest,
    ).toMatchObject({
      music: { assetId: musicId, volumeDb: -18, licenseNote: 'CC BY 4.0, Artist X' },
    });

    // Canceling the run returns the item to where the render started.
    const cancel = await as(
      'editor',
      'POST',
      `/production-runs/${render.job.productionRunId}/cancel`,
    );
    expect(cancel.status).toBe(200);
    expect(await statusOf(w.contentId)).toBe('asset_review');
  });
});
