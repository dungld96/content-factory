// Image jobs (M4 design §5.3, §5.5) through GenerationProcessor against real PostgreSQL and the
// real object store, with the deterministic mock image provider. No network beyond loopback.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  type ImageProvider,
} from '@acf/ai-core';
import { MockImageProvider } from '@acf/ai-core/testing';
import { ImageService, LlmService, ModelCatalog } from '@acf/ai-runtime';
import type { DeadLetterPayload } from '@acf/content-domain';
import type { PrismaClient } from '@acf/database';
import { inspectImage, readAll, sha256Hex, type ObjectStore } from '@acf/storage';

import { GenerationProcessor } from '../src/generation-processor.js';
import { JobStore } from '../src/job-store.js';
import { silentLogger } from '../src/logger.js';
import { appPrisma, createWorld, migratorPrisma, reset, type World } from './support/fixtures.js';
import {
  createImageJobs,
  createImageWorld,
  imageInput,
  testStore,
  type ImageWorld,
} from './support/images.js';

let prisma: PrismaClient;
let migrator: PrismaClient;
let store: ObjectStore;
let world: World;
let iw: ImageWorld;
let mock: MockImageProvider;
let deadLetters: DeadLetterPayload[];

const pixelsOf = (bytes: Uint8Array) => {
  try {
    const i = inspectImage(bytes);
    return i.width * i.height;
  } catch {
    return null;
  }
};

function build(
  options: { store?: ObjectStore | null; providers?: Map<string, ImageProvider> } = {},
) {
  const providers = options.providers ?? new Map<string, ImageProvider>([['mock', mock]]);
  const catalog = new ModelCatalog(prisma, new Map(), providers);
  return new GenerationProcessor({
    prisma,
    jobs: new JobStore(prisma),
    llm: new LlmService(prisma, catalog, new Map(), { providerTimeoutMs: 240_000 }),
    images: new ImageService(prisma, catalog, providers, { pixelsOf }),
    store: options.store === undefined ? store : options.store,
    deadLetter: (p) => {
      deadLetters.push(p);
      return Promise.resolve();
    },
    logger: silentLogger,
    retryDelay: () => 0,
  });
}

const contentStatus = async () =>
  (await prisma.contentItem.findUniqueOrThrow({ where: { id: world.contentItemId } })).status;

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
  mock = new MockImageProvider({ providerKey: 'mock' });
  deadLetters = [];
});

describe('image jobs', () => {
  it('generates the candidates (split by the model n limit), stores them and links their lineage', async () => {
    const sceneId = iw.sceneIds[0] ?? '';
    const [jobId] = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, sceneId, { count: 3 }),
    ]);
    const outcome = await build().process(jobId ?? '');
    expect(outcome.type).toBe('succeeded');

    // n ≤ 2 → two calls (2 + 1), seeds 7 and 8, each with the stored reference image.
    expect(mock.calls.map((c) => [c.request.count, c.request.seed])).toEqual([
      [2, 7],
      [1, 8],
    ]);
    expect(mock.calls[0]?.request.references).toHaveLength(1);
    expect(mock.calls[0]?.request.prompt).toContain('Gadget 1 on a tidy desk');

    const assets = await prisma.asset.findMany({
      where: { generationJobId: jobId ?? '' },
      include: { inputs: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(assets).toHaveLength(3);
    for (const asset of assets) {
      expect(asset).toMatchObject({
        assetType: 'image',
        sourceType: 'generated',
        storyboardSceneId: sceneId,
        contentItemId: world.contentItemId,
        approvalStatus: 'pending',
        mimeType: 'image/png',
        width: 90,
        height: 160,
      });
      expect(asset.inputs.map((i) => [i.inputAssetId, i.role])).toEqual([
        [iw.referenceAssetId, 'character'],
      ]);
      const body = await store.get(asset.storageKey);
      if (!body) throw new Error(`object ${asset.storageKey} is missing`);
      expect(sha256Hex(await readAll(body.stream, 10_000_000))).toBe(asset.checksumSha256);
    }

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId ?? '' },
      include: { invocations: true, productionRun: true },
    });
    expect(job.status).toBe('succeeded');
    expect(job.promptSnapshot).toContain('### image.v1');
    expect(job.productionRun.status).toBe('succeeded');
    expect(
      job.invocations.map((i) => [i.capability, i.status, i.estimatedCost?.toFixed()]),
    ).toEqual([
      ['image_generation', 'succeeded', '0.02'],
      ['image_generation', 'succeeded', '0.01'],
    ]);
    expect(await contentStatus()).toBe('asset_review');
  });

  it('leaves the item in generating_assets until the last scene job of the item ends', async () => {
    const ids = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, iw.sceneIds[0] ?? ''),
      await imageInput(prisma, iw, iw.sceneIds[1] ?? ''),
    ]);
    const processor = build();
    await processor.process(ids[0] ?? '');
    expect(await contentStatus()).toBe('generating_assets');
    const run = await prisma.productionRun.findFirstOrThrow({
      where: { jobs: { some: { id: ids[0] ?? '' } } },
    });
    expect(run.status).toBe('running');
    await processor.process(ids[1] ?? '');
    expect(await contentStatus()).toBe('asset_review');
    expect((await prisma.productionRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      'succeeded',
    );
  });

  it('retries an invalid image, then fails and restores the status when no candidate exists', async () => {
    const notImage = { declaredType: 'image/png', bytes: new TextEncoder().encode('not a png') };
    mock.script(
      { kind: 'result', images: [notImage] },
      { kind: 'result', images: [notImage] },
      { kind: 'result', images: [notImage] },
    );
    const [jobId] = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, iw.sceneIds[0] ?? ''),
    ]);
    const processor = build();
    expect(await processor.process(jobId ?? '')).toMatchObject({
      type: 'retry',
      errorCode: 'OUTPUT_INVALID',
    });
    expect(await processor.process(jobId ?? '')).toMatchObject({ type: 'retry' });
    expect(await processor.process(jobId ?? '')).toMatchObject({
      type: 'failed',
      errorCode: 'OUTPUT_INVALID',
    });
    expect(deadLetters.map((d) => d.errorCode)).toEqual(['OUTPUT_INVALID']);
    expect(await prisma.asset.count({ where: { sourceType: 'generated' } })).toBe(0);
    expect(await contentStatus()).toBe('storyboard_review');
  });

  it('never retries a content-policy block', async () => {
    mock.script({
      kind: 'error',
      error: new ProviderError(ProviderErrorCode.CONTENT_POLICY, 'content policy', {
        outcome: ProviderErrorOutcome.REJECTED,
      }),
    });
    const [jobId] = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, iw.sceneIds[0] ?? ''),
    ]);
    expect(await build().process(jobId ?? '')).toMatchObject({
      type: 'failed',
      errorCode: 'CONTENT_POLICY',
    });
    expect(mock.calls).toHaveLength(1);
  });

  it('fails permanently without storage or with a reference whose file is missing', async () => {
    const [noStore] = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, iw.sceneIds[0] ?? ''),
    ]);
    expect(await build({ store: null }).process(noStore ?? '')).toMatchObject({
      type: 'failed',
      errorCode: 'STORAGE_NOT_CONFIGURED',
    });
    // The world's character asset is metadata-only (no bytes stored).
    const [missing] = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, iw.sceneIds[1] ?? '', {
        references: [{ assetId: world.assetId, role: 'character' }],
      }),
    ]);
    expect(await build().process(missing ?? '')).toMatchObject({
      type: 'failed',
      errorCode: 'REFERENCE_MISSING',
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('discards the result of a job canceled during the call (cost stays in the ledger)', async () => {
    const [jobId] = await createImageJobs(prisma, world, iw, [
      await imageInput(prisma, iw, iw.sceneIds[0] ?? ''),
    ]);
    const cancelling: ImageProvider = {
      providerKey: 'mock',
      capability: 'image_generation',
      generate: async (request, context, signal) => {
        await prisma.generationJob.update({
          where: { id: jobId ?? '' },
          data: { status: 'canceled', activeKey: null, completedAt: new Date() },
        });
        return mock.generate(request, context, signal);
      },
    };
    expect(
      await build({ providers: new Map([['mock', cancelling]]) }).process(jobId ?? ''),
    ).toEqual({ type: 'discarded' });
    expect(await prisma.asset.count({ where: { generationJobId: jobId ?? '' } })).toBe(0);
    expect(await prisma.aiInvocation.count({ where: { generationJobId: jobId ?? '' } })).toBe(1);
  });
});
