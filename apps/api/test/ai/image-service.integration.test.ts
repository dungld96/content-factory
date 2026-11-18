// ImageService against the real registry and ledger (M4 design §3, §6), with the deterministic
// mock image provider standing in for vendor adapters. No network.
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  UsdAmount,
  type GenerationContext,
  type ImageProvider,
  type ImageRequest,
} from '@acf/ai-core';
import { MockImageProvider } from '@acf/ai-core/testing';
import { ImageConstraintError, ImageService, ModelCatalog, RoutingError } from '@acf/ai-runtime';
import type { PrismaClient } from '@acf/database';
import { inspectImage } from '@acf/storage';

import { seedAiRegistry } from '../../src/cli/seed-ai.js';
import { inspector, resetDatabase, userAdmin } from '../support/auth-app.js';
import { seedUsers } from '../support/workspace.js';

let db: pg.Client;
let prisma: PrismaClient;
let projectId: string;

const pixelsOf = (bytes: Uint8Array) => {
  try {
    const i = inspectImage(bytes);
    return i.width * i.height;
  } catch {
    return null;
  }
};
function service(providers: ReadonlyMap<string, ImageProvider>): ImageService {
  return new ImageService(prisma, new ModelCatalog(prisma, new Map(), providers), providers, {
    pixelsOf,
  });
}
const context = (): GenerationContext => ({
  projectId,
  correlationId: `corr-${randomUUID()}`,
  qualityTier: 'economy',
});
const ask = (modelKey: string, extra: Partial<ImageRequest> = {}): ImageRequest => ({
  modelKey,
  prompt: 'PROMPT SECRET: a desk',
  aspectRatio: '9:16',
  count: 1,
  references: [],
  ...extra,
});
const invocationOf = (ctx: GenerationContext) =>
  prisma.aiInvocation.findFirstOrThrow({
    where: { correlationId: ctx.correlationId },
    include: { usageRecords: { orderBy: { metric: 'asc' } } },
  });

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  projectId = randomUUID();
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'Img', 'img-${projectId.slice(0, 8)}', 'vi', 'UTC', '${ids['owner'] ?? ''}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at)
      VALUES ('${projectId}', '${ids['owner'] ?? ''}', 'owner', now());
    COMMIT`);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  await prisma.aiProvider.update({ where: { key: 'openrouter' }, data: { status: 'enabled' } });
  await prisma.aiModel.updateMany({
    where: { modelKey: 'black-forest-labs/flux-3-image-klein' },
    data: { status: 'enabled' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

describe('ImageService', () => {
  it('records intent, outcome and a per-image estimate at the requested resolution tier', async () => {
    const openrouter = new MockImageProvider({ providerKey: 'openrouter' });
    const images = service(new Map([['openrouter', openrouter]]));
    const ctx = context();
    const { result, cost, invocationId } = await images.generate(
      ctx,
      ask('black-forest-labs/flux-3-image-klein', { resolution: '2K', seed: 4 }),
    );
    expect(result.images).toHaveLength(1);
    expect(cost.status).toBe('estimated');
    expect(cost.estimatedCost?.toString()).toBe('0.014'); // the 2k tier, not the 1k price
    const inv = await invocationOf(ctx);
    expect(inv).toMatchObject({
      id: invocationId,
      capability: 'image_generation',
      status: 'succeeded',
      costStatus: 'estimated',
    });
    expect(inv.usageRecords.map((u) => [u.metric, Number(u.quantity)])).toEqual([
      ['output_images', 1],
    ]);
    // The request summary never holds the prompt.
    expect(JSON.stringify(inv.requestSummary)).not.toContain('PROMPT SECRET');
    expect(inv.requestSummary).toMatchObject({ resolution: '2K', count: 1, references: 0 });
  });

  it('prefers a reported cost and records the number of references sent', async () => {
    const openrouter = new MockImageProvider({
      providerKey: 'openrouter',
      steps: [{ kind: 'result', reportedCost: UsdAmount.parse('0.0155') }],
    });
    const ctx = context();
    const ref = { mimeType: 'image/png' as const, bytes: new Uint8Array([0x89, 0x50]) };
    const { cost, result } = await service(new Map([['openrouter', openrouter]])).generate(
      ctx,
      ask('black-forest-labs/flux-3-image-klein', { references: [ref, ref] }),
    );
    expect([cost.status, cost.reportedCost?.toString()]).toEqual(['reported', '0.0155']);
    expect(result.usage.inputImages).toBe(2);
    expect(result.usage.outputPixels).toBe(90 * 160);
  });

  it('refuses disabled or unconfigured models without recording anything', async () => {
    const ctx = context();
    await expect(
      service(new Map()).generate(ctx, ask('bytedance-seed/seedream-5-0-flash')),
    ).rejects.toBeInstanceOf(RoutingError);
    await expect(
      service(new Map()).generate(ctx, ask('black-forest-labs/flux-3-image-klein')),
    ).rejects.toBeInstanceOf(RoutingError); // enabled, but no adapter configured
    expect(await prisma.aiInvocation.count({ where: { correlationId: ctx.correlationId } })).toBe(
      0,
    );
  });

  it('refuses requests beyond the model limits', async () => {
    const images = service(
      new Map([['openrouter', new MockImageProvider({ providerKey: 'openrouter' })]]),
    );
    for (const extra of [
      { count: 2 },
      { resolution: '512' as const },
      { aspectRatio: '16:9' as const, count: 3 },
    ]) {
      const error: unknown = await images
        .generate(context(), ask('black-forest-labs/flux-3-image-klein', extra))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImageConstraintError);
    }
  });

  it('routes the seeded mock model and records a free (zero, estimated) cost', async () => {
    const mock = new MockImageProvider({ providerKey: 'mock' });
    const ctx = context();
    const { cost, result } = await service(new Map([['mock', mock]])).generate(
      ctx,
      ask('mock/solid-image', { count: 3 }),
    );
    expect(result.images).toHaveLength(3);
    expect([cost.status, cost.estimatedCost?.toString()]).toEqual(['estimated', '0']);
  });

  it('records failures with their outcome; a timeout is outcome_unknown', async () => {
    const openrouter = new MockImageProvider({
      providerKey: 'openrouter',
      steps: [
        {
          kind: 'error',
          error: new ProviderError(ProviderErrorCode.CONTENT_POLICY, 'content policy', {
            outcome: ProviderErrorOutcome.REJECTED,
          }),
        },
        {
          kind: 'error',
          error: new ProviderError(ProviderErrorCode.TIMEOUT, 'timed out', {
            outcome: ProviderErrorOutcome.UNKNOWN,
          }),
        },
      ],
    });
    const images = service(new Map([['openrouter', openrouter]]));
    const policy = context();
    await expect(
      images.generate(policy, ask('black-forest-labs/flux-3-image-klein')),
    ).rejects.toThrow('content policy');
    expect(await invocationOf(policy)).toMatchObject({
      status: 'failed',
      errorCode: 'CONTENT_POLICY',
      costStatus: 'unknown',
    });
    const timeout = context();
    await expect(
      images.generate(timeout, ask('black-forest-labs/flux-3-image-klein')),
    ).rejects.toThrow();
    expect((await invocationOf(timeout)).status).toBe('outcome_unknown');
  });
});
