// P1 operator settings over the real application: routes, provider and model status, the audit,
// and the operator allowlist (OPERATOR_EMAILS). The OpenRouter key never appears in a response.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockLlmProvider } from '@acf/ai-core/testing';
import {
  aiRouteListSchema,
  aiRouteSchema,
  meResponseSchema,
  pageSchema,
  aiRegistryEventSchema,
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

const KEY = 'sk-or-v1-feedfacefeedfacefeedfacefeedface';

let api: AuthTestApp;
let db: pg.Client;
let prisma: PrismaClient;
let as: ReturnType<typeof actAs>;

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  // The owner persona is the platform operator here; nobody else is.
  api = await startAuthApp(
    { OPERATOR_EMAILS: emailOf('owner').toUpperCase(), OPENROUTER_API_KEY: KEY },
    { llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]) },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
});

describe('operators (O1)', () => {
  it('reports isOperator from OPERATOR_EMAILS, case-insensitively', async () => {
    const owner = meResponseSchema.parse((await as('owner', 'GET', '/auth/me')).json);
    const editor = meResponseSchema.parse((await as('editor', 'GET', '/auth/me')).json);
    expect([owner.isOperator, editor.isOperator]).toEqual([true, false]);
  });
});

describe('routes (O4)', () => {
  it('lists every task with its routed model', async () => {
    const routes = aiRouteListSchema.parse((await as('viewer', 'GET', '/ai/routes')).json);
    expect(routes.data.map((r) => r.task)).toEqual([
      'script_generation',
      'storyboard_generation',
      'image_generation',
      'video_generation',
      'tts_generation',
    ]);
    expect(routes.data[0]).toMatchObject({
      model: { modelKey: 'mock/echo' },
      provider: { key: 'mock', configured: true },
    });
  });

  it('lets an operator route to an enabled, configured model, and records who did it', async () => {
    const res = await as('owner', 'PUT', '/ai/routes/storyboard_generation', {
      body: { modelKey: 'mock/echo' },
    });
    expect(res.status).toBe(200);
    expect(aiRouteSchema.parse(res.json)).toMatchObject({ model: { modelKey: 'mock/echo' } });
    const event = await prisma.aiRegistryEvent.findFirstOrThrow({
      where: { action: 'route_set', target: 'storyboard_generation' },
      include: { actor: true },
    });
    expect(event).toMatchObject({ source: 'api', actor: { email: emailOf('owner') } });
  });

  it('refuses non-operators, disabled models and missing capabilities', async () => {
    const editor = await as('editor', 'PUT', '/ai/routes/script_generation', {
      body: { modelKey: 'mock/echo' },
    });
    expect(editor.status).toBe(403);
    const disabled = await as('owner', 'PUT', '/ai/routes/script_generation', {
      body: { modelKey: 'anthropic/claude-haiku-5.5' },
    });
    expect([disabled.status, (disabled.json as { error: { code: string } }).error.code]).toEqual([
      422,
      'MODEL_NOT_ROUTABLE',
    ]);
    const wrongCapability = await as('owner', 'PUT', '/ai/routes/image_generation', {
      body: { modelKey: 'mock/echo' },
    });
    expect(wrongCapability.status).toBe(422);
  });
});

describe('status and audit (O5, O6)', () => {
  it('changes provider and model status, each change audited', async () => {
    const provider = await as('owner', 'PATCH', '/ai/providers/openrouter', {
      body: { status: 'enabled' },
    });
    expect(provider.status).toBe(200);
    expect(provider.json).toMatchObject({ key: 'openrouter', status: 'enabled', configured: true });
    // The key is never part of a response.
    expect(JSON.stringify(provider.json)).not.toContain(KEY);

    const model = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'anthropic/claude-haiku-5.5' },
    });
    const changed = await as('owner', 'PATCH', `/ai/models/${model.id}`, {
      body: { status: 'enabled', schemaMode: 'basic' },
    });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ status: 'enabled', schemaMode: 'basic' });

    const events = pageSchema(aiRegistryEventSchema).parse(
      (await as('owner', 'GET', '/ai/registry-events?limit=10')).json,
    );
    expect(events.data.map((e) => e.action).slice(0, 3)).toEqual([
      'model_status',
      'model_schema_mode',
      'provider_status',
    ]);
    expect(events.data[0]).toMatchObject({
      before: { status: 'disabled' },
      after: { status: 'enabled' },
    });
    expect((await as('editor', 'GET', '/ai/registry-events')).status).toBe(403);
  });

  it('answers 404 for an unknown provider', async () => {
    const res = await as('owner', 'PATCH', '/ai/providers/nope', { body: { status: 'enabled' } });
    expect(res.status).toBe(404);
  });
});
