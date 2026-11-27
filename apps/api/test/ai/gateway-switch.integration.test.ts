// P5 (MixRoute) over the real application: the seeded gateway and its curated catalog, the
// gateway switch (preview, choices, apply in one step, audit), the zero-data-retention rule and
// the curated import. No provider is called: the switch and import only touch the registry.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockLlmProvider } from '@acf/ai-core/testing';
import {
  aiRouteListSchema,
  importAiModelsResponseSchema,
  switchAiGatewayResponseSchema,
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
import { actAs, emailOf, seedUsers, signInAll } from '../support/workspace.js';

const MIXROUTE_KEY = 'sk-mixroutefeedfacefeedfacefeedface';

let api: AuthTestApp;
let db: pg.Client;
let prisma: PrismaClient;
let as: ReturnType<typeof actAs>;

async function enableModel(modelKey: string): Promise<void> {
  const model = await prisma.aiModel.findFirstOrThrow({
    where: { modelKey, provider: { key: 'mixroute' } },
  });
  const res = await as('owner', 'PATCH', `/ai/models/${model.id}`, { body: { status: 'enabled' } });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false, mixrouteConfigured: false });
  api = await startAuthApp(
    { OPERATOR_EMAILS: emailOf('owner'), MIXROUTE_API_KEY: MIXROUTE_KEY },
    {
      // The override replaces the LLM map: a stand-in keeps MixRoute configured for text.
      llmProviders: new Map([
        ['mock', new MockLlmProvider({ providerKey: 'mock' })],
        ['mixroute', new MockLlmProvider({ providerKey: 'mixroute' })],
      ]),
      // What MixRoute's GET /models would list for the key (no network in tests).
      modelListings: new Map([
        ['mixroute', () => Promise.resolve(['qwen3-max', 'claude-haiku-5-5'])],
      ]),
    },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('seeded MixRoute gateway', () => {
  it('exists as a gateway with its curated models, all disabled until reviewed', async () => {
    const provider = await prisma.aiProvider.findUniqueOrThrow({
      where: { key: 'mixroute' },
      include: { models: { include: { prices: true } } },
    });
    expect(provider).toMatchObject({ kind: 'gateway', status: 'disabled' });
    expect(provider.models.map((m) => m.modelKey).sort()).toEqual([
      'claude-haiku-5-5',
      'deepseek-v4-flash',
      'doubao-seedream-5-5-261028',
      'gemini-2.5-flash-image',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(provider.models.every((m) => m.status === 'disabled')).toBe(true);
    expect(
      provider.models.flatMap((m) => m.prices).every((p) => p.source === 'official_page'),
    ).toBe(true);
  });
});

describe('gateway switch (P5 G6)', () => {
  it('previews nothing to move while the gateway is disabled', async () => {
    const res = await as('owner', 'POST', '/ai/gateways/mixroute/switch', {
      body: { apply: false },
    });
    expect(res.status).toBe(200);
    const plan = switchAiGatewayResponseSchema.parse(res.json);
    expect(plan.tasks.every((t) => t.target === null && t.keptBecause === 'no_candidate')).toBe(
      true,
    );
  });

  it('suggests the only routable model per step and applies all routes at once', async () => {
    expect(
      (await as('owner', 'PATCH', '/ai/providers/mixroute', { body: { status: 'enabled' } }))
        .status,
    ).toBe(200);
    await enableModel('gemini-3.5-flash-lite');
    await enableModel('doubao-seedream-5-5-261028');

    const preview = switchAiGatewayResponseSchema.parse(
      (await as('owner', 'POST', '/ai/gateways/mixroute/switch', { body: { apply: false } })).json,
    );
    const target = Object.fromEntries(preview.tasks.map((t) => [t.task, t.target?.modelKey]));
    expect(target).toEqual({
      script_generation: 'gemini-3.5-flash-lite',
      storyboard_generation: 'gemini-3.5-flash-lite',
      image_generation: 'doubao-seedream-5-5-261028',
      video_generation: undefined,
      tts_generation: undefined,
    });
    // A preview writes nothing.
    expect(await prisma.aiRegistryEvent.count({ where: { action: 'route_set' } })).toBe(0);

    const applied = switchAiGatewayResponseSchema.parse(
      (
        await as('owner', 'POST', '/ai/gateways/mixroute/switch', {
          body: { apply: true, choices: { storyboard_generation: null } },
        })
      ).json,
    );
    expect(applied.tasks.map((t) => [t.task, t.action])).toEqual([
      ['script_generation', 'switched'],
      ['storyboard_generation', 'kept'],
      ['image_generation', 'switched'],
      ['video_generation', 'kept'],
      ['tts_generation', 'kept'],
    ]);
    const routes = aiRouteListSchema.parse((await as('viewer', 'GET', '/ai/routes')).json);
    expect(routes.data.map((r) => r.provider?.key)).toEqual([
      'mixroute',
      'mock',
      'mixroute',
      'mock',
      'mock',
    ]);
    const events = await prisma.aiRegistryEvent.findMany({
      where: { action: 'route_set' },
      include: { actor: true },
    });
    expect(events.map((e) => e.target).sort()).toEqual(['image_generation', 'script_generation']);
    expect(events.every((e) => e.source === 'api' && e.actor?.email === emailOf('owner'))).toBe(
      true,
    );
    // The key never appears in a response.
    expect(JSON.stringify(applied)).not.toContain(MIXROUTE_KEY);
  });

  it('refuses a choice outside the candidates, non-operators and unknown gateways', async () => {
    const bad = await as('owner', 'POST', '/ai/gateways/mixroute/switch', {
      body: { apply: true, choices: { script_generation: 'claude-haiku-5-5' } }, // still disabled
    });
    expect([bad.status, (bad.json as { error: { code: string } }).error.code]).toEqual([
      422,
      'MODEL_NOT_ROUTABLE',
    ]);
    expect(
      (await as('editor', 'POST', '/ai/gateways/mixroute/switch', { body: { apply: false } }))
        .status,
    ).toBe(403);
    expect(
      (await as('owner', 'POST', '/ai/gateways/nowhere/switch', { body: { apply: false } })).status,
    ).toBe(404);
  });

  it('never routes a zero-data-retention step to MixRoute', async () => {
    const res = await as('owner', 'PUT', '/ai/routes/script_generation', {
      body: { modelKey: 'gemini-3.5-flash-lite', providerKey: 'mixroute', zeroDataRetention: true },
    });
    expect(res.status).toBe(422);
  });
});

describe('curated import (P5 G4)', () => {
  it('previews MixRoute models with their source page and refuses unknown keys', async () => {
    const res = await as('owner', 'POST', '/ai/models/import', {
      body: {
        gateway: 'mixroute',
        catalog: 'llm',
        modelKeys: ['claude-haiku-5-5', 'gpt-6.1-sol'],
        apply: false,
      },
    });
    expect(res.status).toBe(200);
    const preview = importAiModelsResponseSchema.parse(res.json);
    expect(preview.entries.map((e) => [e.modelKey, e.ok])).toEqual([
      ['claude-haiku-5-5', true],
      ['gpt-6.1-sol', false],
    ]);
    expect(preview.entries[0]?.summary).toContain('https://mixroute.ai/models/claude-haiku-5-5/');
  });

  it('imports a text model outside the verified list, disabled and without prices', async () => {
    const res = await as('owner', 'POST', '/ai/models/import', {
      body: {
        gateway: 'mixroute',
        catalog: 'llm',
        modelKeys: ['qwen3-max', 'not-offered'],
        tier: 'balanced',
        apply: true,
      },
    });
    expect(res.status).toBe(200);
    const applied = importAiModelsResponseSchema.parse(res.json);
    expect(applied.entries.map((e) => [e.modelKey, e.ok, e.action])).toEqual([
      ['qwen3-max', true, 'created'],
      ['not-offered', false, 'refused'],
    ]);
    const model = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'qwen3-max', provider: { key: 'mixroute' } },
      include: { prices: true, capabilities: true },
    });
    expect(model).toMatchObject({ status: 'disabled', qualityTier: 'balanced', prices: [] });
    expect(model.capabilities.map((c) => c.capability)).toEqual(['llm']);
  });

  it('has no video or voice catalog yet, and OpenRouter keys still need author/slug', async () => {
    const video = await as('owner', 'POST', '/ai/models/import', {
      body: { gateway: 'mixroute', catalog: 'video', modelKeys: ['sora-2'], apply: false },
    });
    expect(video.status).toBe(422);
    const bare = await as('owner', 'POST', '/ai/models/import', {
      body: { catalog: 'llm', modelKeys: ['gemini-3.5-flash'], apply: false },
    });
    expect(bare.status).toBe(400);
  });
});
