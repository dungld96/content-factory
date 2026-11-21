// P1d: model import and prices over HTTP, against a local stand-in for OpenRouter's public
// catalog (no network, no key, no cost). Operators only; every write is audited.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockLlmProvider } from '@acf/ai-core/testing';
import { aiModelSchema, importAiModelsResponseSchema } from '@acf/contracts';
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

const CATALOG = {
  data: [
    {
      id: 'acme/tiny-chat',
      name: 'Acme Tiny Chat',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'seed', 'response_format', 'structured_outputs'],
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
    },
  ],
};

let catalog: Server;
let api: AuthTestApp;
let db: pg.Client;
let prisma: PrismaClient;
let as: ReturnType<typeof actAs>;

beforeAll(async () => {
  catalog = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CATALOG));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve));
  const port = (catalog.address() as AddressInfo).port;
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  api = await startAuthApp(
    {
      OPERATOR_EMAILS: emailOf('owner'),
      OPENROUTER_BASE_URL: `http://127.0.0.1:${String(port)}/api/v1`,
    },
    { llmProviders: new Map([['mock', new MockLlmProvider({ providerKey: 'mock' })]]) },
  );
  as = actAs(api.baseUrl, await signInAll(api.baseUrl, ids));
});

afterAll(async () => {
  await api.close();
  await prisma.$disconnect();
  await db.end();
  await new Promise<void>((resolve) => {
    catalog.close(() => {
      resolve();
    });
  });
});

describe('model import (P1d)', () => {
  it('previews without writing, then imports a disabled model with its prices, audited', async () => {
    const body = { catalog: 'llm', modelKeys: ['acme/tiny-chat', 'acme/missing'], tier: 'economy' };
    expect(
      (await as('editor', 'POST', '/ai/models/import', { body: { ...body, apply: false } })).status,
    ).toBe(403);

    const preview = importAiModelsResponseSchema.parse(
      (await as('owner', 'POST', '/ai/models/import', { body: { ...body, apply: false } })).json,
    );
    expect(preview.applied).toBe(false);
    expect(preview.entries.map((e) => [e.modelKey, e.ok])).toEqual([
      ['acme/tiny-chat', true],
      ['acme/missing', false],
    ]);
    expect(preview.entries[0]?.summary).toContain('input_tokens = 0.0000001');
    expect(await prisma.aiModel.count({ where: { modelKey: 'acme/tiny-chat' } })).toBe(0);

    const applied = importAiModelsResponseSchema.parse(
      (await as('owner', 'POST', '/ai/models/import', { body: { ...body, apply: true } })).json,
    );
    expect(applied.entries.map((e) => [e.modelKey, e.action])).toEqual([
      ['acme/tiny-chat', 'created'],
      ['acme/missing', 'refused'],
    ]);
    const model = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'acme/tiny-chat' },
      include: { prices: true },
    });
    expect(model.status).toBe('disabled');
    expect(model.prices.map((p) => p.metric).sort()).toEqual(['input_tokens', 'output_tokens']);
    const event = await prisma.aiRegistryEvent.findFirstOrThrow({
      where: { action: 'model_imported', target: 'acme/tiny-chat' },
    });
    expect(event).toMatchObject({ source: 'api' });
    expect(event.actorId).not.toBeNull();
  });

  it('appends a price (operators only), never changing earlier rows', async () => {
    const model = await prisma.aiModel.findFirstOrThrow({ where: { modelKey: 'acme/tiny-chat' } });
    const price = {
      metric: 'request',
      usdPerUnit: '0.001',
      source: 'manual_estimate',
      sourceUrl: 'https://example.com/pricing',
    };
    expect(
      (await as('editor', 'POST', `/ai/models/${model.id}/prices`, { body: price })).status,
    ).toBe(403);
    const res = await as('owner', 'POST', `/ai/models/${model.id}/prices`, { body: price });
    expect(res.status).toBe(201);
    const dto = aiModelSchema.parse(res.json);
    expect(dto.activePrices.find((p) => p.metric === 'request')).toBeDefined();
    expect(await prisma.aiModelPrice.count({ where: { modelId: model.id } })).toBe(3);
    expect(
      await prisma.aiRegistryEvent.count({ where: { action: 'price_added', source: 'api' } }),
    ).toBe(1);
  });

  it('answers 502 when the catalog cannot be read', async () => {
    const res = await as('owner', 'POST', '/ai/models/import', {
      body: { catalog: 'video', modelKeys: ['acme/clip'], apply: false },
    });
    expect([res.status, (res.json as { error: { code: string } }).error.code]).toEqual([
      502,
      'CATALOG_UNAVAILABLE',
    ]);
  });
});
