// Render jobs (M6 design §3–§8) through GenerationProcessor against real PostgreSQL, the real
// object store and FFmpeg: inputs are stored files; the render, its QC report, outputs, lineage
// and status transitions are checked. No provider call, no network beyond loopback.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LlmService, ModelCatalog } from '@acf/ai-runtime';
import {
  activeRenderJobKey,
  renderExecutionKey,
  renderSettings,
  upscaledFrom,
  type DeadLetterPayload,
  type RenderManifest,
} from '@acf/content-domain';
import type { PrismaClient } from '@acf/database';
import { probeFile, synthTone, synthVideo } from '@acf/media';
import { assetObjectKey, readAll, sha256Hex, uuidv7, type ObjectStore } from '@acf/storage';

import { GenerationProcessor } from '../src/generation-processor.js';
import { JobStore } from '../src/job-store.js';
import { silentLogger } from '../src/logger.js';
import { appPrisma, createWorld, migratorPrisma, reset, type World } from './support/fixtures.js';
import { createImageWorld, testStore, type ImageWorld } from './support/images.js';

let prisma: PrismaClient;
let migrator: PrismaClient;
let store: ObjectStore;
let world: World;
let iw: ImageWorld;
let dir: string;
let deadLetters: DeadLetterPayload[];

function build() {
  const catalog = new ModelCatalog(prisma, new Map());
  return new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma),
    llm: new LlmService(prisma, catalog, new Map(), { providerTimeoutMs: 120_000 }),
    store,
    deadLetter: (p) => {
      deadLetters.push(p);
      return Promise.resolve();
    },
    logger: silentLogger,
    retryDelay: () => 0,
  });
}

/** Stores a local file as an uploaded asset of the content item (as M5a uploads do). */
async function uploadAsset(
  file: string,
  assetType: 'video' | 'audio',
  mimeType: 'video/mp4' | 'audio/mpeg',
  metadata: Record<string, string> = {},
): Promise<string> {
  const bytes = new Uint8Array(await readFile(file));
  const id = uuidv7();
  const key = assetObjectKey({
    projectId: world.projectId,
    assetId: id,
    sha256Hex: sha256Hex(bytes),
    mimeType,
  });
  await store.putIfAbsent(key, bytes, { contentType: mimeType, sha256Hex: sha256Hex(bytes) });
  await prisma.asset.create({
    data: {
      id,
      projectId: world.projectId,
      assetType,
      sourceType: 'upload',
      storageKey: key,
      mimeType,
      sizeBytes: BigInt(bytes.byteLength),
      checksumSha256: sha256Hex(bytes),
      metadata,
      createdById: world.userId,
    },
  });
  return id;
}

/** A render and its job exactly as the API creates them (M6c): intent first, status rendering. */
async function createRender(
  manifest: RenderManifest,
): Promise<{ renderId: string; jobId: string }> {
  const settings = renderSettings(true);
  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: world.contentItemId } });
    const run = await tx.productionRun.create({
      data: {
        projectId: world.projectId,
        contentItemId: world.contentItemId,
        requestedById: world.userId,
      },
    });
    const renderId = uuidv7();
    const job = await tx.generationJob.create({
      data: {
        projectId: world.projectId,
        contentItemId: world.contentItemId,
        productionRunId: run.id,
        kind: 'render',
        activeKey: activeRenderJobKey(world.contentItemId),
        idempotencyKey: `render:${renderId}`,
        executionKey: renderExecutionKey(manifest, settings),
        input: { renderId },
        previousContentStatus: item.status,
        promptTemplateId: settings.renderer,
        modelId: world.modelId,
        requestedById: world.userId,
      },
    });
    await tx.render.create({
      data: {
        id: renderId,
        projectId: world.projectId,
        contentItemId: world.contentItemId,
        storyboardVersionId: manifest.storyboardVersionId,
        generationJobId: job.id,
        manifest,
        settings,
        executionKey: renderExecutionKey(manifest, settings),
        upscaledFrom: upscaledFrom(manifest),
        createdById: world.userId,
      },
    });
    await tx.contentItem.update({
      where: { id: world.contentItemId },
      data: { status: 'rendering' },
    });
    return { renderId, jobId: job.id };
  });
}

async function manifestWith(
  options: { music?: boolean; missingClip?: boolean } = {},
): Promise<RenderManifest> {
  const clip = await uploadAsset(path.join(dir, 'clip.mp4'), 'video', 'video/mp4');
  const voice = await uploadAsset(path.join(dir, 'voice.mp3'), 'audio', 'audio/mpeg', {
    purpose: 'voiceover',
  });
  const music = options.music
    ? await uploadAsset(path.join(dir, 'music.mp3'), 'audio', 'audio/mpeg', { purpose: 'music' })
    : null;
  const [s1, s2] = iw.sceneIds;
  return {
    storyboardVersionId: iw.storyboardVersionId,
    scenes: [
      {
        sceneId: s1 ?? '',
        sceneNumber: 1,
        durationMs: 2000,
        clipAssetId: options.missingClip ? uuidv7() : clip,
        clipDurationMs: 2000,
        clipWidth: 720,
        clipHeight: 1280,
        keyframeAssetId: iw.referenceAssetId,
        voiceoverAssetId: voice,
        voiceoverDurationMs: 1500,
        text: 'Năm món đồ nhỏ giúp bàn làm việc gọn gàng hơn.',
        clipModel: 'google/veo-3.1-lite',
        voiceoverModel: 'microsoft/mai-voice-2.1',
      },
      {
        sceneId: s2 ?? '',
        sceneNumber: 2,
        durationMs: 1800,
        clipAssetId: clip,
        clipDurationMs: 2000,
        clipWidth: 720,
        clipHeight: 1280,
        keyframeAssetId: null,
        voiceoverAssetId: null,
        voiceoverDurationMs: null,
        text: '',
        clipModel: 'google/veo-3.1-lite',
        voiceoverModel: null,
      },
    ],
    music: music ? { assetId: music, volumeDb: -18, licenseNote: 'CC BY 4.0, test tone' } : null,
  };
}

beforeAll(async () => {
  prisma = appPrisma();
  migrator = migratorPrisma();
  store = testStore();
  dir = await mkdtemp(path.join(tmpdir(), 'acf-render-it-'));
  await synthVideo({ out: path.join(dir, 'clip.mp4'), width: 720, height: 1280, durationSec: 2 });
  await synthTone({ out: path.join(dir, 'voice.mp3'), durationSec: 1.5 });
  await synthTone({ out: path.join(dir, 'music.mp3'), durationSec: 1, frequency: 220 });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
  await migrator.$disconnect();
});

beforeEach(async () => {
  await reset(migrator);
  world = await createWorld(prisma);
  iw = await createImageWorld(prisma, store, world);
  await prisma.contentItem.update({
    where: { id: world.contentItemId },
    data: { status: 'asset_review' },
  });
  deadLetters = [];
});

describe('render jobs', () => {
  it('renders, checks and stores the video, captions and thumbnail with their lineage', async () => {
    const manifest = await manifestWith({ music: true });
    const { renderId, jobId } = await createRender(manifest);
    expect(await build().process(jobId)).toEqual({ type: 'succeeded', versionId: renderId });

    const render = await prisma.render.findUniqueOrThrow({
      where: { id: renderId },
      include: {
        videoAsset: { include: { inputs: true } },
        subtitleAsset: true,
        thumbnailAsset: { include: { inputs: true } },
      },
    });
    expect(render).toMatchObject({
      durationMs: 3800,
      upscaledFrom: '720p',
      reviewStatus: 'pending',
    });
    expect(render.videoAsset).toMatchObject({
      assetType: 'render',
      sourceType: 'generated',
      generationJobId: jobId,
      mimeType: 'video/mp4',
      width: 1080,
      height: 1920,
    });
    expect(render.videoAsset?.inputs.map((i) => i.role).sort()).toEqual([
      'clip',
      'music',
      'voiceover',
    ]);
    expect(render.subtitleAsset).toMatchObject({
      assetType: 'subtitle',
      mimeType: 'application/x-subrip',
    });
    expect(render.thumbnailAsset?.inputs.map((i) => [i.inputAssetId, i.role])).toEqual([
      [iw.referenceAssetId, 'keyframe'],
    ]);
    expect(render.qc).toMatchObject({
      passed: true,
      measured: { width: 1080, height: 1920, fps: 30 },
    });

    // The stored files are what the record says.
    const body = await store.get(render.videoAsset?.storageKey ?? '');
    if (!body) throw new Error('render object missing');
    const bytes = await readAll(body.stream, 100_000_000);
    expect(sha256Hex(bytes)).toBe(render.videoAsset?.checksumSha256);
    const local = path.join(dir, `${renderId}.mp4`);
    await writeFile(local, bytes);
    const probe = await probeFile(local);
    expect(probe.streams.map((s) => s.codec)).toEqual(['h264', 'aac']);
    const srt = await store.get(render.subtitleAsset?.storageKey ?? '');
    if (!srt) throw new Error('caption object missing');
    // Captions wrap at balanced line breaks (M8.5 Q7): compare the text, not the line layout.
    const captions = new TextDecoder().decode(await readAll(srt.stream, 100_000));
    expect(captions.replace(/\n(?!\n|\d)/g, ' ')).toContain('Năm món đồ nhỏ giúp bàn làm việc');

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        productionRun: true,
        invocations: true,
      },
    });
    expect(job.status).toBe('succeeded');
    expect(job.invocations).toEqual([]); // rendering has no provider cost
    expect(job.productionRun.status).toBe('succeeded');
    expect(
      job.events
        .map((e) => e.detail as { type: string; stage?: string })
        .filter((d) => d.type === 'render_stage')
        .map((d) => d.stage),
    ).toEqual(['normalise', 'concat', 'narration', 'mix', 'loudness', 'encode']);
    expect(
      (await prisma.contentItem.findUniqueOrThrow({ where: { id: world.contentItemId } })).status,
    ).toBe('quality_review');
  }, 240_000);

  it('drill: a render whose worker died mid-attempt is redone once and stored once', async () => {
    const { renderId, jobId } = await createRender(await manifestWith({}));
    // The first worker started the render, reached the first stage, and died.
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'running', attempt: 1, startedAt: new Date() },
    });
    await prisma.jobEvent.create({
      data: {
        projectId: world.projectId,
        jobId,
        fromStatus: 'running',
        toStatus: 'running',
        attempt: 1,
        detail: { type: 'render_stage', stage: 'normalise' },
      },
    });

    // BullMQ redelivers the stalled job (or the reconciler requeues it): a new attempt.
    expect(await build().process(jobId)).toEqual({ type: 'succeeded', versionId: renderId });
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    expect([job.status, job.attempt]).toEqual(['succeeded', 2]);
    expect(
      job.events.some((e) => (e.detail as { type: string }).type === 'stalled_recovered'),
    ).toBe(true);
    // One set of outputs, all referenced by the render.
    const outputs = await prisma.asset.findMany({ where: { generationJobId: jobId } });
    expect(outputs.map((a) => a.assetType).sort()).toEqual(['image', 'render', 'subtitle']);
    const render = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
    expect(new Set([render.videoAssetId, render.subtitleAssetId, render.thumbnailAssetId])).toEqual(
      new Set(outputs.map((a) => a.id)),
    );
  }, 240_000);

  it('fails without retry when an input file is missing, and restores the content status', async () => {
    const { renderId, jobId } = await createRender(await manifestWith({ missingClip: true }));
    expect(await build().process(jobId)).toEqual({
      type: 'failed',
      errorCode: 'REFERENCE_MISSING',
    });
    const render = await prisma.render.findUniqueOrThrow({ where: { id: renderId } });
    expect(render.videoAssetId).toBeNull();
    expect(deadLetters.map((d) => d.errorCode)).toEqual(['REFERENCE_MISSING']);
    expect(
      (await prisma.contentItem.findUniqueOrThrow({ where: { id: world.contentItemId } })).status,
    ).toBe('asset_review');
  }, 120_000);
});
