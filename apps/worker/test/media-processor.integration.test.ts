// Video and TTS jobs (M5 design §5–§7) through GenerationProcessor against real PostgreSQL, the
// real object store and FFmpeg/FFprobe, with the deterministic mock providers. Polls are run by
// the test (the queue is replaced by a recorder), so every step is explicit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  type TtsProvider,
  type VideoProvider,
} from '@acf/ai-core';
import { MockTtsProvider, MockVideoProvider } from '@acf/ai-core/testing';
import { ImageService, LlmService, ModelCatalog, TtsService, VideoService } from '@acf/ai-runtime';
import { VIDEO_POLL_JOB_NAME, type DeadLetterPayload } from '@acf/content-domain';
import type { PrismaClient } from '@acf/database';
import { DEFAULT_MEDIA_TOOLS, probeFile, type MediaTools } from '@acf/media';
import { readAll, sha256Hex, StorageError, type ObjectStore } from '@acf/storage';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GenerationProcessor } from '../src/generation-processor.js';
import { JobStore } from '../src/job-store.js';
import { MediaToolsGate } from '../src/media-tools-gate.js';
import { silentLogger } from '../src/logger.js';
import { audioRenderer, clipRenderer } from '../src/mock-media.js';
import { appPrisma, createWorld, migratorPrisma, reset, type World } from './support/fixtures.js';
import { createImageWorld, testStore, type ImageWorld } from './support/images.js';
import {
  createMediaJobs,
  createMediaModels,
  ttsInput,
  videoInput,
  type MediaWorld,
} from './support/media.js';

let prisma: PrismaClient;
let migrator: PrismaClient;
let store: ObjectStore;
let world: World;
let iw: ImageWorld;
let mw: MediaWorld;
let deadLetters: DeadLetterPayload[];
let polls: { jobId: string; pollCount: number; delayMs: number }[];

function build(
  options: {
    video?: VideoProvider;
    tts?: TtsProvider;
    toolsGate?: MediaToolsGate;
    tools?: MediaTools;
    store?: ObjectStore;
  } = {},
) {
  const videos = new Map<string, VideoProvider>(options.video ? [['mock', options.video]] : []);
  const ttsProviders = new Map<string, TtsProvider>(options.tts ? [['mock', options.tts]] : []);
  const catalog = new ModelCatalog(prisma, new Map(), new Map(), videos, ttsProviders);
  return new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma),
    llm: new LlmService(prisma, catalog, new Map(), { providerTimeoutMs: 120_000 }),
    images: new ImageService(prisma, catalog, new Map(), { pixelsOf: () => null }),
    videos: new VideoService(prisma, catalog, videos),
    tts: new TtsService(prisma, catalog, ttsProviders),
    schedulePoll: (jobId, pollCount, delayMs) => {
      polls.push({ jobId, pollCount, delayMs });
      return Promise.resolve();
    },
    store: options.store ?? store,
    deadLetter: (p) => {
      deadLetters.push(p);
      return Promise.resolve();
    },
    logger: silentLogger,
    retryDelay: () => 0,
    storageRetryDelaysMs: [0, 0, 0],
    ...(options.toolsGate ? { mediaToolsGate: options.toolsGate } : {}),
    ...(options.tools ? { mediaTools: options.tools } : {}),
  });
}

/** A tools check that reports FFprobe missing (P3d R6). */
const noProbeGate = () =>
  new MediaToolsGate(DEFAULT_MEDIA_TOOLS, () =>
    Promise.resolve({ ffmpeg: 'ffmpeg version 7', ffprobe: null }),
  );

const videoMock = (options: ConstructorParameters<typeof MockVideoProvider>[0] = {}) =>
  new MockVideoProvider({ providerKey: 'mock', renderClip: clipRenderer(), ...options });

const job = (id: string) =>
  prisma.generationJob.findUniqueOrThrow({
    where: { id },
    include: { invocations: true, events: { orderBy: { createdAt: 'asc' } } },
  });

const contentStatus = async () =>
  (await prisma.contentItem.findUniqueOrThrow({ where: { id: world.contentItemId } })).status;

async function newVideoJob(): Promise<string> {
  const sceneId = iw.sceneIds[0] ?? '';
  const [id] = await createMediaJobs(prisma, world, 'video_generation', mw.videoModelId, [
    await videoInput(prisma, iw, mw, sceneId),
  ]);
  return id ?? '';
}

/** Runs the scheduled polls until the job leaves `running` (bounded). */
async function drainPolls(processor: GenerationProcessor, jobId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const next = polls.shift();
    if (!next) return;
    expect(next.jobId).toBe(jobId);
    await processor.process(jobId, VIDEO_POLL_JOB_NAME);
  }
  throw new Error('too many polls');
}

beforeAll(() => {
  prisma = appPrisma();
  migrator = migratorPrisma();
  store = testStore();
});

afterAll(async () => {
  await prisma.$disconnect();
  await migrator.$disconnect();
});

beforeEach(async () => {
  await reset(migrator);
  world = await createWorld(prisma);
  iw = await createImageWorld(prisma, store, world);
  mw = await createMediaModels(prisma);
  deadLetters = [];
  polls = [];
});

describe('video jobs', () => {
  it('submits once, polls, downloads, validates and stores the clip with its lineage', async () => {
    const mock = videoMock();
    const processor = build({ video: mock });
    const jobId = await newVideoJob();

    const submitted = await processor.process(jobId);
    expect(submitted).toMatchObject({ type: 'submitted' });
    let row = await job(jobId);
    expect(row).toMatchObject({ status: 'running', providerKey: 'mock', pollCount: 0 });
    expect(row.providerJobId).toMatch(/^mock-vid-1-2s-360x640$/);
    expect(row.submittedAt).not.toBeNull();
    expect(row.invocations.map((i) => i.status)).toEqual(['started']);
    expect(polls).toEqual([{ jobId, pollCount: 0, delayMs: 15_000 }]);
    expect(mock.submissions).toHaveLength(1);
    expect(mock.submissions[0]?.firstFrame?.mimeType).toBe('image/png');
    expect(mock.submissions[0]?.prompt).toContain('Start exactly from the first frame');

    // Poll 1: still running → next poll after 30 s.
    expect(await processor.process(jobId, VIDEO_POLL_JOB_NAME)).toEqual({
      type: 'polling',
      pollCount: 1,
    });
    expect(polls.at(-1)).toEqual({ jobId, pollCount: 1, delayMs: 30_000 });
    polls.shift();
    // Poll 2: completed → download, FFprobe, store, succeed.
    const done = await processor.process(jobId, VIDEO_POLL_JOB_NAME);
    expect(done).toMatchObject({ type: 'succeeded' });
    expect(polls).toHaveLength(1);

    row = await job(jobId);
    expect(row).toMatchObject({ status: 'succeeded', providerStatus: 'completed', pollCount: 2 });
    expect(
      row.invocations.map((i) => [i.status, i.costStatus, i.estimatedCost?.toFixed()]),
    ).toEqual([['succeeded', 'estimated', '0.1']]);
    expect(row.events.map((e) => (e.detail as { type: string }).type)).toEqual([
      'created',
      'attempt_started',
      'submit_started',
      'provider_job_accepted',
      'provider_status',
      'output_delivered',
      'succeeded',
    ]);
    expect(row.promptSnapshot).toContain('### video.v1');
    // P3d R1: the delivered file is the asset's object; no second copy.
    expect(row.deliveredAt).not.toBeNull();
    expect(row.stagedAssetId).not.toBeNull();

    const [clip] = await prisma.asset.findMany({
      where: { generationJobId: jobId },
      include: { inputs: true },
    });
    expect(clip).toMatchObject({
      assetType: 'video',
      sourceType: 'generated',
      storyboardSceneId: iw.sceneIds[0],
      mimeType: 'video/mp4',
      width: 360,
      height: 640,
      approvalStatus: 'pending',
    });
    expect(clip?.durationMs).toBeGreaterThanOrEqual(1800);
    expect(clip?.inputs.map((i) => [i.inputAssetId, i.role])).toEqual([
      [iw.referenceAssetId, 'keyframe'],
    ]);
    const body = await store.get(clip?.storageKey ?? '');
    if (!body) throw new Error('clip object is missing');
    const bytes = await readAll(body.stream, 50_000_000);
    expect(sha256Hex(bytes)).toBe(clip?.checksumSha256);
    const dir = await mkdtemp(path.join(tmpdir(), 'acf-test-'));
    try {
      await writeFile(path.join(dir, 'c.mp4'), bytes);
      const probe = await probeFile(path.join(dir, 'c.mp4'));
      expect(probe.streams.find((st) => st.type === 'video')?.codec).toBe('h264');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // A new candidate to review (like images): the content item moves to asset review.
    expect(await contentStatus()).toBe('asset_review');
  });

  it('a worker restart resumes polling and never submits a second time', async () => {
    const first = videoMock();
    const jobId = await newVideoJob();
    await build({ video: first }).process(jobId);
    expect(first.submissions).toHaveLength(1);

    // The process died; BullMQ (or the reconciler) delivers `generate` again to a new worker.
    const second = videoMock();
    const restarted = build({ video: second });
    polls = [];
    expect(await restarted.process(jobId)).toEqual({ type: 'polling', pollCount: 0 });
    expect(polls).toEqual([{ jobId, pollCount: 0, delayMs: 0 }]);
    await drainPolls(restarted, jobId);

    expect(second.submissions).toHaveLength(0);
    const row = await job(jobId);
    expect(row.status).toBe('succeeded');
    expect(row.attempt).toBe(1);
    expect(row.invocations).toHaveLength(1);
    expect(await prisma.asset.count({ where: { generationJobId: jobId } })).toBe(1);
  });

  it('fails with SUBMIT_OUTCOME_UNKNOWN when the worker stopped during the submit call', async () => {
    const mock = videoMock();
    const jobId = await newVideoJob();
    // Simulate a crash between "intent recorded" and "provider job id recorded".
    const jobs = new JobStore(prisma);
    const started = await jobs.startAttempt(jobId);
    if (!started) throw new Error('not started');
    const invocation = await prisma.aiInvocation.create({
      data: {
        projectId: world.projectId,
        contentItemId: world.contentItemId,
        generationJobId: jobId,
        correlationId: jobId,
        capability: 'video_generation',
        providerId: (await prisma.aiProvider.findUniqueOrThrow({ where: { key: 'mock' } })).id,
        modelId: mw.videoModelId,
        requestSummary: {},
      },
    });
    expect(await jobs.markSubmitting(started, invocation.id, 'mock')).toBe(true);

    expect(await build({ video: mock }).process(jobId)).toEqual({
      type: 'failed',
      errorCode: 'SUBMIT_OUTCOME_UNKNOWN',
    });
    expect(mock.submissions).toHaveLength(0);
    const row = await job(jobId);
    expect(row.status).toBe('failed');
    expect(row.invocations.map((i) => i.status)).toEqual(['outcome_unknown']);
    expect(deadLetters.map((d) => d.errorCode)).toEqual(['SUBMIT_OUTCOME_UNKNOWN']);
    expect(await contentStatus()).toBe('storyboard_review');
  });

  it('an unknown submit outcome is never resent', async () => {
    const mock = videoMock({
      steps: [
        {
          kind: 'submit-error',
          error: new ProviderError(ProviderErrorCode.TIMEOUT, 'timeout', {
            outcome: ProviderErrorOutcome.UNKNOWN,
          }),
        },
      ],
    });
    const jobId = await newVideoJob();
    expect(await build({ video: mock }).process(jobId)).toEqual({
      type: 'failed',
      errorCode: 'SUBMIT_OUTCOME_UNKNOWN',
    });
    const row = await job(jobId);
    expect([row.status, row.errorCode]).toEqual(['failed', 'SUBMIT_OUTCOME_UNKNOWN']);
    expect(row.invocations.map((i) => i.status)).toEqual(['outcome_unknown']);
  });

  it('a refused submit clears the intent and retries; a rejected one fails', async () => {
    const mock = videoMock({
      steps: [
        {
          kind: 'submit-error',
          error: new ProviderError(ProviderErrorCode.RATE_LIMITED, 'busy', {
            outcome: ProviderErrorOutcome.REJECTED,
          }),
        },
      ],
    });
    const processor = build({ video: mock });
    const jobId = await newVideoJob();
    expect(await processor.process(jobId)).toMatchObject({ type: 'retry' });
    let row = await job(jobId);
    expect(row).toMatchObject({ status: 'queued', submittedAt: null, invocationId: null });
    // Next attempt submits normally.
    expect(await processor.process(jobId)).toMatchObject({ type: 'submitted' });
    row = await job(jobId);
    expect(row.attempt).toBe(2);
    expect(row.invocations.map((i) => i.status).sort()).toEqual(['failed', 'started']);
  });

  it('records a provider failure with its message and no clip', async () => {
    const mock = videoMock({ steps: [{ kind: 'fail', error: 'content moderation' }] });
    const processor = build({ video: mock });
    const jobId = await newVideoJob();
    await processor.process(jobId);
    await drainPolls(processor, jobId);
    const row = await job(jobId);
    expect([row.status, row.errorCode, row.errorMessage]).toEqual([
      'failed',
      'PROVIDER_FAILED',
      'content moderation',
    ]);
    expect(row.invocations.map((i) => i.status)).toEqual(['failed']);
    expect(await prisma.asset.count({ where: { generationJobId: jobId } })).toBe(0);
  });

  it('rejects an invalid clip without resubmitting (already paid)', async () => {
    const mock = new MockVideoProvider({ providerKey: 'mock' }); // placeholder bytes, not MP4
    const processor = build({ video: mock });
    const jobId = await newVideoJob();
    await processor.process(jobId);
    await drainPolls(processor, jobId);
    const row = await job(jobId);
    expect([row.status, row.errorCode]).toEqual(['failed', 'OUTPUT_INVALID']);
    expect(mock.submissions).toHaveLength(1);
    // P3d R2: the clip was delivered, so its cost is recorded (not unknown).
    expect(row.invocations.map((i) => [i.status, i.costStatus])).toEqual([
      ['succeeded', 'estimated'],
    ]);
  });

  it('a canceled job drops its polls', async () => {
    const mock = videoMock();
    const processor = build({ video: mock });
    const jobId = await newVideoJob();
    await processor.process(jobId);
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'canceled', activeKey: null, completedAt: new Date() },
    });
    expect(await processor.process(jobId, VIDEO_POLL_JOB_NAME)).toEqual({ type: 'skipped' });
  });
});

describe('TTS jobs', () => {
  it('synthesizes on a zero-data-retention route, validates and stores the voice-over', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() });
    const sceneId = iw.sceneIds[1] ?? '';
    const input = await ttsInput(prisma, iw, mw, sceneId);
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [input]);
    expect(await build({ tts: mock }).process(jobId ?? '')).toMatchObject({ type: 'succeeded' });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      text: input.text,
      voice: 'mock-a',
      language: 'vi',
      dataPolicy: { zeroDataRetention: true },
    });
    const row = await job(jobId ?? '');
    expect(row.status).toBe('succeeded');
    expect(row.invocations.map((i) => [i.capability, i.status])).toEqual([['tts', 'succeeded']]);
    const [audio] = await prisma.asset.findMany({ where: { generationJobId: jobId ?? '' } });
    expect(audio).toMatchObject({
      assetType: 'audio',
      sourceType: 'generated',
      storyboardSceneId: sceneId,
      mimeType: 'audio/mpeg',
    });
    expect(audio?.durationMs).toBeGreaterThan(1000);
    expect(audio?.metadata).toMatchObject({
      purpose: 'voiceover',
      voiceoverHash: input.voiceoverHash,
      exceedsScene: false,
    });
    expect(await contentStatus()).toBe('asset_review');
  });

  it('fails without retry when the provider returns audio that does not decode', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock' }); // placeholder bytes
    const sceneId = iw.sceneIds[0] ?? '';
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, sceneId),
    ]);
    expect(await build({ tts: mock }).process(jobId ?? '')).toEqual({
      type: 'failed',
      errorCode: 'OUTPUT_INVALID',
    });
  });

  it('ends the job without a second call when the speech call outcome is unknown (P3 W5)', async () => {
    const mock = new MockTtsProvider({
      providerKey: 'mock',
      steps: [
        {
          kind: 'error',
          error: new ProviderError(ProviderErrorCode.TIMEOUT, 'timed out', {
            outcome: ProviderErrorOutcome.UNKNOWN,
          }),
        },
      ],
    });
    const sceneId = iw.sceneIds[0] ?? '';
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, sceneId),
    ]);
    expect(await build({ tts: mock }).process(jobId ?? '')).toEqual({
      type: 'failed',
      errorCode: 'CALL_OUTCOME_UNKNOWN',
    });
    expect(mock.calls).toHaveLength(1);
    const row = await job(jobId ?? '');
    expect(row).toMatchObject({ status: 'failed', attempt: 1, errorCode: 'CALL_OUTCOME_UNKNOWN' });
    expect(row.invocations.map((i) => i.status)).toEqual(['outcome_unknown']);
  });
});

describe('missing FFmpeg/FFprobe (P3d R6)', () => {
  it('refuses a clip before submitting it: no provider call, nothing charged', async () => {
    const mock = videoMock();
    const jobId = await newVideoJob();
    expect(await build({ video: mock, toolsGate: noProbeGate() }).process(jobId)).toEqual({
      type: 'failed',
      errorCode: 'MEDIA_TOOLS_MISSING',
    });
    expect(mock.submissions).toHaveLength(0);
    const row = await job(jobId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'MEDIA_TOOLS_MISSING' });
    expect(row.errorMessage).toContain('nothing was sent to the provider');
    expect(row.invocations).toHaveLength(0);
  });

  it('refuses a voice-over before synthesizing it', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() });
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, iw.sceneIds[0] ?? ''),
    ]);
    expect(await build({ tts: mock, toolsGate: noProbeGate() }).process(jobId ?? '')).toEqual({
      type: 'failed',
      errorCode: 'MEDIA_TOOLS_MISSING',
    });
    expect(mock.calls).toHaveLength(0);
    expect((await job(jobId ?? '')).invocations).toHaveLength(0);
  });

  it('lets the job through once the tools are there', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() });
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, iw.sceneIds[0] ?? ''),
    ]);
    const gate = new MediaToolsGate(DEFAULT_MEDIA_TOOLS);
    expect(await build({ tts: mock, toolsGate: gate }).process(jobId ?? '')).toMatchObject({
      type: 'succeeded',
    });
  });
});

/** FFprobe disappears after the paid call (the owner's case): validation cannot run. */
const NO_PROBE: MediaTools = { ...DEFAULT_MEDIA_TOOLS, ffprobePath: '/nonexistent/ffprobe' };

/** A store whose writes fail as if storage were down (reads still work). */
function downStore(): ObjectStore {
  return {
    putIfAbsent: () => Promise.reject(new StorageError('STORAGE_UNAVAILABLE', 'down')),
    head: (key) => store.head(key),
    get: (key, range) => store.get(key, range),
    getBytes: (key, max) => store.getBytes(key, max),
  };
}

describe('delivered output is kept when a later step fails (P3d R1, R2, R5)', () => {
  it('keeps a delivered clip and its cost when FFprobe is missing', async () => {
    const mock = videoMock();
    const processor = build({ video: mock, tools: NO_PROBE });
    const jobId = await newVideoJob();
    await processor.process(jobId);
    await drainPolls(processor, jobId);
    const row = await job(jobId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'MEDIA_TOOLS_MISSING' });
    expect(row.errorMessage).toContain('no new charge');
    expect(row.deliveredAt).not.toBeNull();
    expect(row.stagedMimeType).toBe('video/mp4');
    expect(mock.submissions).toHaveLength(1);
    expect(row.invocations.map((i) => [i.status, i.costStatus])).toEqual([
      ['succeeded', 'estimated'],
    ]);
    const bytes = await store.getBytes(row.stagedObjectKey ?? '', 50_000_000);
    expect(bytes && sha256Hex(bytes)).toBe(row.stagedSha256);
    expect(await prisma.asset.count({ where: { generationJobId: jobId } })).toBe(0);
  });

  it('keeps a delivered voice-over when FFprobe is missing', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() });
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, iw.sceneIds[0] ?? ''),
    ]);
    expect(await build({ tts: mock, tools: NO_PROBE }).process(jobId ?? '')).toEqual({
      type: 'failed',
      errorCode: 'MEDIA_TOOLS_MISSING',
    });
    const row = await job(jobId ?? '');
    expect(row.attempt).toBe(1);
    expect(mock.calls).toHaveLength(1);
    expect(row.stagedMimeType).toBe('audio/mpeg');
    expect(await store.head(row.stagedObjectKey ?? '')).not.toBeNull();
  });

  it('never pays twice when storage is down after a voice-over was synthesized', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() });
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, iw.sceneIds[0] ?? ''),
    ]);
    expect(await build({ tts: mock, store: downStore() }).process(jobId ?? '')).toEqual({
      type: 'failed',
      errorCode: 'OUTPUT_NOT_STORED',
    });
    expect(mock.calls).toHaveLength(1);
    const row = await job(jobId ?? '');
    expect(row).toMatchObject({ status: 'failed', attempt: 1, stagedObjectKey: null });
    expect(row.deliveredAt).not.toBeNull();
  });

  it('a delivered clip that could not be stored ends STORAGE_UNAVAILABLE (finishable)', async () => {
    const mock = videoMock();
    const processor = build({ video: mock, store: downStore() });
    const jobId = await newVideoJob();
    // The submit reads the keyframe (reads work) and needs no write.
    await processor.process(jobId);
    await drainPolls(processor, jobId);
    const row = await job(jobId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'STORAGE_UNAVAILABLE' });
    expect(row.deliveredAt).not.toBeNull();
    expect(mock.submissions).toHaveLength(1);
  });
});

describe('finish jobs (P3d R3, R4)', () => {
  /** A finish job for a failed, delivered job (what Resume creates). */
  async function finishJobFor(failedId: string): Promise<string> {
    const failed = await prisma.generationJob.findUniqueOrThrow({ where: { id: failedId } });
    const row = await prisma.generationJob.create({
      data: {
        projectId: failed.projectId,
        contentItemId: failed.contentItemId,
        productionRunId: failed.productionRunId,
        kind: failed.kind,
        storyboardSceneId: failed.storyboardSceneId,
        activeKey: `${failed.storyboardSceneId ?? ''}:${failed.kind}`,
        idempotencyKey: `finish:${failed.id}`,
        executionKey: failed.executionKey,
        input: failed.input ?? {},
        previousContentStatus: failed.previousContentStatus,
        promptTemplateId: failed.promptTemplateId,
        modelId: failed.modelId,
        requestedById: failed.requestedById,
        recoverFromJobId: failed.id,
      },
    });
    return row.id;
  }

  it('finishes a delivered clip after FFprobe is installed: one submission in total', async () => {
    const mock = videoMock();
    const jobId = await newVideoJob();
    const broken = build({ video: mock, tools: NO_PROBE });
    await broken.process(jobId);
    await drainPolls(broken, jobId);
    const failed = await job(jobId);
    expect(failed.errorCode).toBe('MEDIA_TOOLS_MISSING');

    const finishId = await finishJobFor(jobId);
    expect(await build({ video: mock }).process(finishId)).toMatchObject({ type: 'succeeded' });
    expect(mock.submissions).toHaveLength(1);
    const finished = await job(finishId);
    expect(finished).toMatchObject({ status: 'succeeded' });
    expect(finished.invocations).toHaveLength(0);
    const [clip] = await prisma.asset.findMany({
      where: { storyboardSceneId: iw.sceneIds[0] ?? '', assetType: 'video' },
    });
    expect(clip).toMatchObject({
      id: failed.stagedAssetId,
      storageKey: failed.stagedObjectKey,
      generationJobId: jobId,
      checksumSha256: failed.stagedSha256,
    });
  });

  it('finishes a delivered voice-over without synthesizing again', async () => {
    const mock = new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() });
    const [jobId] = await createMediaJobs(prisma, world, 'tts_generation', mw.ttsModelId, [
      await ttsInput(prisma, iw, mw, iw.sceneIds[0] ?? ''),
    ]);
    await build({ tts: mock, tools: NO_PROBE }).process(jobId ?? '');
    const finishId = await finishJobFor(jobId ?? '');
    expect(await build({ tts: mock }).process(finishId)).toMatchObject({ type: 'succeeded' });
    expect(mock.calls).toHaveLength(1);
    const failed = await job(jobId ?? '');
    expect(
      await prisma.asset.findUnique({ where: { id: failed.stagedAssetId ?? '' } }),
    ).toMatchObject({
      assetType: 'audio',
      generationJobId: jobId,
    });
  });

  it('downloads a delivered clip again from the provider when it was never stored (free)', async () => {
    const mock = videoMock();
    const jobId = await newVideoJob();
    const down = build({ video: mock, store: downStore() });
    await down.process(jobId);
    await drainPolls(down, jobId);
    expect((await job(jobId)).errorCode).toBe('STORAGE_UNAVAILABLE');

    const finishId = await finishJobFor(jobId);
    expect(await build({ video: mock }).process(finishId)).toMatchObject({ type: 'succeeded' });
    expect(mock.submissions).toHaveLength(1);
    const finished = await job(finishId);
    expect(finished.stagedObjectKey).not.toBeNull();
    expect(await prisma.asset.count({ where: { id: finished.stagedAssetId ?? '' } })).toBe(1);
  });
});
