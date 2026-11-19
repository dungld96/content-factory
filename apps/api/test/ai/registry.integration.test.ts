// Read-only AI registry API (M2 design package §8.2) over the real application, plus the S1
// development seed. Money is checked as exact decimal strings.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  aiModelDetailSchema,
  aiModelSchema,
  aiProviderListSchema,
  pageSchema,
} from '@acf/contracts';
import type { PrismaClient } from '@acf/database';

import { CATALOG_SNAPSHOT, seedAiRegistry } from '../../src/cli/seed-ai.js';
import {
  inspector,
  resetDatabase,
  startAuthApp,
  userAdmin,
  type AuthTestApp,
} from '../support/auth-app.js';
import { actAs, seedUsers, signInAll } from '../support/workspace.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

let api: AuthTestApp;
let configured: AuthTestApp;
let db: pg.Client;
let prisma: PrismaClient;
let as: ReturnType<typeof actAs>;
let asConfigured: ReturnType<typeof actAs>;

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  api = await startAuthApp();
  configured = await startAuthApp({ OPENROUTER_API_KEY: KEY });
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
  asConfigured = actAs(configured.baseUrl, await signInAll(configured.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await configured.close();
  await prisma.$disconnect();
  await db.end();
});

const models = async (query = '') => {
  const res = await as('viewer', 'GET', `/ai/models${query}`);
  expect(res.status).toBe(200);
  return pageSchema(aiModelSchema).parse(res.json);
};

describe('seed (S1)', () => {
  it('registers OpenRouter (disabled without a key), three disabled models and the mock provider', async () => {
    const providers = await prisma.aiProvider.findMany({ orderBy: { key: 'asc' } });
    expect(providers.map((p) => [p.key, p.kind, p.status])).toEqual([
      ['mock', 'mock', 'enabled'],
      ['openrouter', 'gateway', 'disabled'],
    ]);
    const rows = await prisma.aiModel.findMany({ include: { provider: true } });
    expect(
      rows
        .filter((m) => m.provider.key === 'openrouter')
        .map((m) => [m.modelKey, m.status])
        .sort(),
    ).toEqual([
      // M5: video benchmark candidates, seeded disabled.
      ['alibaba/wan-3.0', 'disabled'],
      ['anthropic/claude-haiku-5.5', 'disabled'],
      // M4: image benchmark candidates, seeded disabled.
      ['black-forest-labs/flux-3-image-klein', 'disabled'],
      ['bytedance-seed/seedream-5-0-flash', 'disabled'],
      ['deepseek/deepseek-v4-flash', 'disabled'],
      // M5: TTS benchmark candidates, seeded disabled.
      ['elevenlabs/eleven-flash-v2.5', 'disabled'],
      ['elevenlabs/eleven-v4', 'disabled'],
      ['google/gemini-3.5-flash-lite', 'disabled'],
      ['google/veo-3.1-lite', 'disabled'],
      ['kwaivgi/kling-v3.0-std', 'disabled'],
      ['microsoft/mai-voice-2.1', 'disabled'],
      ['qwen/qwen-image-2.1-turbo', 'disabled'],
    ]);
  });

  it('is idempotent', async () => {
    const before = await prisma.aiModelPrice.count();
    const again = await seedAiRegistry(prisma, { openrouterConfigured: true });
    expect(again.models.map((m) => m.action)).toEqual(Array(12).fill('unchanged'));
    expect(again.openrouterStatus).toBe('disabled'); // existing rows are never changed by the seed
    expect(await prisma.aiModelPrice.count()).toBe(before);
    expect(CATALOG_SNAPSHOT).toHaveLength(3);
  });
});

describe('GET /ai/providers', () => {
  it('lists providers with configured=false when no key is set, and never a credential', async () => {
    const res = await as('outsider', 'GET', '/ai/providers');
    expect(res.status).toBe(200);
    const body = aiProviderListSchema.parse(res.json);
    expect(body.data.map((p) => [p.key, p.configured])).toEqual([
      ['mock', false],
      ['openrouter', false],
    ]);
  });

  it('reports configured=true when the deployment has a key, without exposing it', async () => {
    const res = await asConfigured('viewer', 'GET', '/ai/providers');
    const body = aiProviderListSchema.parse(res.json);
    expect(body.data.find((p) => p.key === 'openrouter')?.configured).toBe(true);
    expect(JSON.stringify(res.json)).not.toContain('sk-or-v1');
  });

  it('requires authentication', async () => {
    expect((await as(null, 'GET', '/ai/providers')).status).toBe(401);
  });
});

describe('GET /ai/models', () => {
  it('returns active prices as exact decimal strings, never exponent notation', async () => {
    const page = await models('?providerKey=openrouter&limit=100');
    const flash = page.data.find((m) => m.modelKey === 'deepseek/deepseek-v4-flash');
    expect(flash).toMatchObject({
      canonicalSlug: 'deepseek/deepseek-v4-flash-20260423',
      capabilities: ['llm'],
      status: 'disabled',
      qualityTier: 'economy',
      contextLength: 1_048_576,
      maxOutputTokens: 393_216,
      supportedParameters: [
        'max_tokens',
        'response_format',
        'seed',
        'stop',
        'structured_outputs',
        'temperature',
        'top_p',
      ],
    });
    const price = (metric: string) =>
      flash?.activePrices.find((p) => p.metric === metric && p.minPromptTokens === 0);
    expect(price('input_tokens')).toMatchObject({
      unitPriceUsd: '0.00000009',
      sourceValue: '0.00000009',
      currency: 'USD',
      source: 'official_api',
      sourceUrl: 'https://openrouter.ai/api/v1/models',
      effectiveFrom: '2026-11-17T16:05:34.000Z',
    });
    expect(price('cached_input_tokens')?.unitPriceUsd).toBe('0.000000018');
    for (const m of page.data) {
      for (const p of m.activePrices) expect(p.unitPriceUsd).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it('keeps the published value when the price had to be rounded to 18 decimals', async () => {
    const page = await models('?providerKey=openrouter');
    const lite = page.data.find((m) => m.modelKey === 'google/gemini-3.5-flash-lite');
    expect(lite?.activePrices.find((p) => p.metric === 'cache_write_tokens')).toMatchObject({
      unitPriceUsd: '0.000000083333333333',
      sourceValue: '0.0000000833333333333333',
    });
    expect(lite?.activePrices.map((p) => p.metric).sort()).toEqual([
      'cache_write_tokens',
      'cached_input_tokens',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
    ]);
  });

  it('exposes prompt-size tiers', async () => {
    const page = await models('?providerKey=openrouter');
    const haiku = page.data.find((m) => m.modelKey === 'anthropic/claude-haiku-5.5');
    expect(
      haiku?.activePrices
        .filter((p) => p.metric === 'input_tokens')
        .map((p) => [p.minPromptTokens, p.unitPriceUsd])
        .sort(),
    ).toEqual([
      [0, '0.0000001'],
      [100_000, '0.0000005'],
    ]);
  });

  it.each([
    ['?status=enabled', ['mock/echo', 'mock/solid-image', 'mock/still-video', 'mock/tone-tts']],
    ['?providerKey=mock', ['mock/echo', 'mock/solid-image', 'mock/still-video', 'mock/tone-tts']],
    [
      '?capability=video_generation',
      ['alibaba/wan-3.0', 'google/veo-3.1-lite', 'kwaivgi/kling-v3.0-std', 'mock/still-video'],
    ],
    [
      '?capability=tts',
      [
        'elevenlabs/eleven-flash-v2.5',
        'elevenlabs/eleven-v4',
        'microsoft/mai-voice-2.1',
        'mock/tone-tts',
      ],
    ],
    [
      '?capability=image_generation',
      [
        'black-forest-labs/flux-3-image-klein',
        'bytedance-seed/seedream-5-0-flash',
        'mock/solid-image',
        'qwen/qwen-image-2.1-turbo',
      ],
    ],
    ['?qualityTier=premium', ['mock/solid-image', 'mock/still-video', 'mock/tone-tts']],
  ])('filters %s', async (query, keys) => {
    expect((await models(query)).data.map((m) => m.modelKey).sort()).toEqual(keys);
  });

  it('paginates with an opaque cursor', async () => {
    const first = await models('?limit=2');
    expect(first.data).toHaveLength(2);
    expect(first.page.nextCursor).not.toBeNull();
    const all = first.data.map((m) => m.id);
    let cursor = first.page.nextCursor;
    while (cursor !== null) {
      const page = await models(`?limit=2&cursor=${cursor}`);
      all.push(...page.data.map((m) => m.id));
      cursor = page.page.nextCursor;
    }
    // M2 seed: 3 text models + mock/echo; M4 adds 3 image candidates + mock/solid-image;
    // M5 adds 3 video + 3 TTS candidates and two mock media models.
    expect(all).toHaveLength(16);
    expect(new Set(all).size).toBe(16);
  });

  it('rejects unknown filters and bad cursors', async () => {
    expect((await as('viewer', 'GET', '/ai/models?status=on')).status).toBe(400);
    expect((await as('viewer', 'GET', '/ai/models?cursor=nope')).status).toBe(400);
    expect((await as('viewer', 'GET', '/ai/models?secret=1')).status).toBe(400);
  });
});

describe('GET /ai/models/:modelId', () => {
  it('includes the full price history', async () => {
    const id =
      (await models('?providerKey=mock')).data.find((m) => m.modelKey === 'mock/echo')?.id ?? '';
    const res = await as('editor', 'GET', `/ai/models/${id}`);
    expect(res.status).toBe(200);
    const detail = aiModelDetailSchema.parse(res.json);
    expect(detail.priceHistory.map((p) => [p.metric, p.unitPriceUsd]).sort()).toEqual([
      ['input_tokens', '0'],
      ['output_tokens', '0'],
    ]);
  });

  it('404 for an unknown model, 400 for a malformed id', async () => {
    expect(
      (await as('viewer', 'GET', '/ai/models/00000000-0000-7000-8000-00000000dead')).status,
    ).toBe(404);
    expect((await as('viewer', 'GET', '/ai/models/not-a-uuid')).status).toBe(400);
  });
});
