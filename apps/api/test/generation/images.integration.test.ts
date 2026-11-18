// Scene images over HTTP (M4 design §5–§7): plan/estimate, generate (one job per scene),
// unknown-cost confirmation, reference checks, candidate review, keyframes, reuse of identical
// scenes and cancel. The worker is not running here: a finished job is simulated by inserting
// its result rows exactly as the worker does (apps/worker covers the real path).
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockImageProvider, MockLlmProvider } from '@acf/ai-core/testing';
import type {
  AssetDto,
  ImageEstimateDto,
  ImageGenerateResponseDto,
  StoryboardImagesDto,
} from '@acf/contracts';
import type { PrismaClient } from '@acf/database';

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
let as: ReturnType<typeof actAs>;

type World = Fixture & GenerationFixture;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test accessor
const bodyOf = <T>(res: { json: unknown }) => res.json as T;
const codeOf = (res: { json: unknown }) =>
  (res.json as { error?: { code?: string } } | null)?.error?.code;

/** A fixture whose storyboard is approved and whose item is in storyboard_review. */
async function approvedWorld(): Promise<World> {
  const base = await createFixture(db, ids);
  const w: World = { ...base, ...(await addGenerationFixture(db, ids, base)) };
  await db.query(
    `UPDATE content_items SET status = 'storyboard_review' WHERE id = '${w.contentId}'`,
  );
  const res = await as('editor', 'POST', `/storyboards/${w.storyboardId}/approve`);
  expect(res.status).toBe(200);
  return w;
}

/** What the worker writes when an image job succeeds (one candidate). */
async function simulateSuccess(jobId: string): Promise<string> {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
  const input = job.input as { sceneId: string; sceneHash: string };
  const assetId = randomUUID();
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
        assetType: 'image',
        sourceType: 'generated',
        generationJobId: jobId,
        storyboardSceneId: input.sceneId,
        storageKey: `projects/${job.projectId}/assets/${assetId}/x.png`,
        mimeType: 'image/png',
        sizeBytes: 10n,
        checksumSha256: 'a'.repeat(64),
        width: 90,
        height: 160,
        metadata: { sceneHash: input.sceneHash },
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
      QUEUE_PREFIX: `acf-img-${randomUUID().slice(0, 8)}`,
    },
    {
      llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]),
      imageProviders: new Map([['mock', new MockImageProvider({ providerKey: 'mock' })]]),
    },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('estimate and generate', () => {
  it('plans every scene with the routed model, 2K by default, and prices it', async () => {
    const w = await approvedWorld();
    const res = await as('viewer', 'POST', `/storyboards/${w.storyboardId}/images/estimate`, {
      body: { count: 2 },
    });
    expect(res.status).toBe(200);
    expect(bodyOf<ImageEstimateDto>(res)).toEqual({
      modelKey: 'mock/solid-image',
      resolution: '2K',
      count: 2,
      scenes: [
        {
          sceneId: w.sceneId,
          sceneNumber: 1,
          action: 'generate',
          references: 0,
          estimatedUsd: '0',
        },
      ],
      totalEstimatedUsd: '0',
      unknownCost: false,
    });
  });

  it('queues one image job per scene, moves the item to generating_assets, and refuses a second', async () => {
    const w = await approvedWorld();
    const res = await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, {
      body: { count: 2, seed: 3 },
    });
    expect(res.status).toBe(202);
    const body = bodyOf<ImageGenerateResponseDto>(res);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ kind: 'image_generation', status: 'queued' });
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: body.jobs[0]?.id ?? '' },
    });
    expect(job).toMatchObject({
      storyboardSceneId: w.sceneId,
      previousContentStatus: 'storyboard_review',
      promptTemplateId: 'image.v1',
    });
    expect(job.input).toMatchObject({ count: 2, seed: 3, resolution: '2K', aspectRatio: '9:16' });
    expect(
      (await prisma.contentItem.findUniqueOrThrow({ where: { id: w.contentId } })).status,
    ).toBe('generating_assets');

    const again = await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, {
      body: {},
    });
    expect(again.status).toBe(202);
    expect(bodyOf<ImageGenerateResponseDto>(again)).toMatchObject({
      productionRunId: null,
      jobs: [],
      estimate: { scenes: [{ action: 'skip_in_progress' }] },
    });
  });

  it('requires confirmation when the cost is unknown', async () => {
    const w = await approvedWorld();
    // An enabled image model without prices: its cost cannot be estimated.
    const provider = await prisma.aiProvider.findUniqueOrThrow({ where: { key: 'mock' } });
    await prisma.aiModel.upsert({
      where: { providerId_modelKey: { providerId: provider.id, modelKey: 'mock/unpriced-image' } },
      create: {
        providerId: provider.id,
        modelKey: 'mock/unpriced-image',
        displayName: 'Unpriced',
        qualityTier: 'premium',
        status: 'enabled',
        supportedParameters: ['aspect_ratio'],
        imageConstraints: {
          maxImages: 1,
          maxReferences: 0,
          aspectRatios: ['9:16'],
          resolutions: [],
          seed: false,
        },
        capabilities: { create: { capability: 'image_generation' } },
      },
      update: {},
    });
    const body = { modelKey: 'mock/unpriced-image' };
    const refused = await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, {
      body,
    });
    expect([refused.status, codeOf(refused)]).toEqual([422, 'UNKNOWN_COST_NOT_ACCEPTED']);
    const estimate = bodyOf<ImageEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${w.storyboardId}/images/estimate`, { body }),
    );
    expect(estimate).toMatchObject({
      unknownCost: true,
      totalEstimatedUsd: null,
      resolution: null,
    });
    const accepted = await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, {
      body: { ...body, acceptUnknownCost: true },
    });
    expect(accepted.status).toBe(202);
  });

  it('refuses limits the model does not support, and references without a stored file', async () => {
    const w = await approvedWorld();
    const tooMany = await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, {
      body: { resolution: '1.5K' }, // the mock model offers 1K and 2K
    });
    expect([tooMany.status, codeOf(tooMany)]).toEqual([422, 'MODEL_LIMITS']);

    // A storyboard whose scene references a metadata-only asset (no bytes in storage).
    const base = await createFixture(db, ids);
    const g = await addGenerationFixture(db, ids, base);
    await db.query(`INSERT INTO storyboard_scene_assets (project_id, scene_id, asset_id)
      VALUES ('${base.projectId}', '${g.sceneId}', '${base.assetId}');
      UPDATE content_items SET status = 'storyboard_review' WHERE id = '${base.contentId}'`);
    expect((await as('editor', 'POST', `/storyboards/${g.storyboardId}/approve`)).status).toBe(200);
    const missing = await as('editor', 'POST', `/storyboards/${g.storyboardId}/images/generate`, {
      body: {},
    });
    expect([missing.status, codeOf(missing)]).toEqual([422, 'REFERENCE_FILE_MISSING']);
  });

  it('returns the item to storyboard_review when its image run is canceled', async () => {
    const w = await approvedWorld();
    const run = bodyOf<ImageGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, { body: {} }),
    ).productionRunId;
    expect((await as('editor', 'POST', `/production-runs/${run ?? ''}/cancel`)).status).toBe(200);
    expect(
      (await prisma.contentItem.findUniqueOrThrow({ where: { id: w.contentId } })).status,
    ).toBe('storyboard_review');
  });
});

describe('review, keyframes and reuse', () => {
  it('reviews a candidate, selects it as keyframe, and protects the keyframe', async () => {
    const w = await approvedWorld();
    const job = bodyOf<ImageGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, { body: {} }),
    ).jobs[0];
    const assetId = await simulateSuccess(job?.id ?? '');

    let view = bodyOf<StoryboardImagesDto>(
      await as('viewer', 'GET', `/storyboards/${w.storyboardId}/images`),
    );
    expect(view).toMatchObject({ approved: true, keyframesComplete: false });
    expect(view.scenes[0]?.candidates.map((c) => c.id)).toEqual([assetId]);
    expect(view.scenes[0]?.lastJob?.status).toBe('succeeded');

    const pending = await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, {
      body: { assetId },
    });
    expect([pending.status, codeOf(pending)]).toEqual([409, 'KEYFRAME_INVALID']);
    const approved = await as('editor', 'POST', `/assets/${assetId}/approve`);
    expect(bodyOf<AssetDto>(approved)).toMatchObject({ approvalStatus: 'approved' });
    expect(bodyOf<AssetDto>(approved).reviewedAt).not.toBeNull();

    view = bodyOf<StoryboardImagesDto>(
      await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, { body: { assetId } }),
    );
    expect(view.keyframesComplete).toBe(true);
    expect(view.scenes[0]?.keyframe?.id).toBe(assetId);

    const reject = await as('editor', 'POST', `/assets/${assetId}/reject`);
    expect([reject.status, codeOf(reject)]).toEqual([409, 'KEYFRAME_INVALID']);
    const archive = await as('editor', 'POST', `/assets/${assetId}/archive`);
    expect(archive.status).toBe(409);
  });

  it('reuses the keyframe of an identical scene in a newer storyboard version (no new job)', async () => {
    const w = await approvedWorld();
    const job = bodyOf<ImageGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${w.storyboardId}/images/generate`, { body: {} }),
    ).jobs[0];
    const assetId = await simulateSuccess(job?.id ?? '');
    await as('editor', 'POST', `/assets/${assetId}/approve`);
    await as('editor', 'PUT', `/scenes/${w.sceneId}/keyframe`, { body: { assetId } });

    // On-screen text is not part of the image: the edited scene keeps the same image hash.
    const edited = await as('editor', 'PATCH', `/scenes/${w.sceneId}`, {
      body: { onScreenText: 'New caption' },
    });
    expect(edited.status).toBe(201);
    const next = bodyOf<{ id: string; scenes: { id: string }[] }>(edited);
    expect((await as('editor', 'POST', `/storyboards/${next.id}/approve`)).status).toBe(200);

    const plan = bodyOf<ImageEstimateDto>(
      await as('viewer', 'POST', `/storyboards/${next.id}/images/estimate`, { body: {} }),
    );
    expect(plan.scenes[0]?.action).toBe('reuse_keyframe');
    const res = bodyOf<ImageGenerateResponseDto>(
      await as('editor', 'POST', `/storyboards/${next.id}/images/generate`, { body: {} }),
    );
    expect(res).toMatchObject({ productionRunId: null, jobs: [] });
    const view = bodyOf<StoryboardImagesDto>(
      await as('viewer', 'GET', `/storyboards/${next.id}/images`),
    );
    expect(view.scenes[0]?.keyframe?.id).toBe(assetId);
    expect(view.keyframesComplete).toBe(true);
    const events = await prisma.sceneKeyframeEvent.findMany({
      where: { storyboardSceneId: next.scenes[0]?.id ?? '' },
    });
    expect(events.map((e) => e.reason)).toEqual(['reused']);
  });

  it('only reviews images and reference images', async () => {
    const base = await createFixture(db, ids);
    const res = await as('editor', 'POST', `/assets/${base.assetId}/approve`);
    expect(res.status).toBe(200); // the fixture asset is a reference image
    expect(bodyOf<AssetDto>(res).reviewedById).toBe(ids['editor']);
  });
});
