// Operator CLI (design package §8.1) against a local fixture server that plays OpenRouter's
// public catalog and chat endpoint. Nothing reaches the network (loopback only).
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@acf/database';

import { runAiRegistryCli, SMOKE_MAX_OUTPUT_TOKENS } from '../../src/cli/ai-registry-cli.js';
import { CATALOG_SNAPSHOT } from '../../src/cli/seed-ai.js';
import { inspector, resetDatabase, userAdmin } from '../support/auth-app.js';
import { seedUsers } from '../support/workspace.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

let server: Server;
let baseUrl: string;
let catalog: unknown[];
const chatBodies: Record<string, unknown>[] = [];
let db: pg.Client;
let prisma: PrismaClient;
let projectSlug: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/v1/models') {
        res.end(JSON.stringify({ data: catalog }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        chatBodies.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        );
        res.end(
          JSON.stringify({
            id: 'gen-smoke-1',
            model: 'deepseek/deepseek-v4-flash-20260423',
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cost: 0.000001584 },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`;

  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  const projectId = randomUUID();
  projectSlug = `smoke-${projectId.slice(0, 8)}`;
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'Smoke', '${projectSlug}', 'en', 'UTC', '${ids['owner'] ?? ''}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at)
      VALUES ('${projectId}', '${ids['owner'] ?? ''}', 'owner', now());
    COMMIT`);
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await prisma.$disconnect();
  await db.end();
});

beforeEach(() => {
  catalog = structuredClone(CATALOG_SNAPSHOT) as unknown[];
});

/** Runs the CLI with captured output against the fixture server. */
async function cli(args: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAiRegistryCli(
    args.split(' ').filter(Boolean),
    prisma,
    { OPENROUTER_BASE_URL: baseUrl, ...env },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const apiEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
  REDIS_URL: 'redis://127.0.0.1:1',
  SESSION_SECRETS: 'test-session-secret-0123456789abcdef',
  CSRF_SECRET: 'test-csrf-secret-0123456789abcdef!!',
};

describe('model import-openrouter', () => {
  it('dry run shows the plan and writes nothing', async () => {
    const result = await cli('model import-openrouter deepseek/deepseek-v4-flash');
    expect(result.code).toBe(0);
    expect(result.out).toContain('input_tokens=0.00000009');
    expect(result.out).toContain('(dry run: nothing written');
    expect(await prisma.aiModel.count()).toBe(0);
  });

  it('refuses a new model without a tier', async () => {
    const result = await cli('model import-openrouter deepseek/deepseek-v4-flash --apply');
    expect(result.code).toBe(1);
    expect(result.out).toContain('pass --tier');
    expect(await prisma.aiModel.count()).toBe(0);
  });

  it('creates a disabled model with official prices and a disabled provider', async () => {
    const result = await cli(
      'model import-openrouter deepseek/deepseek-v4-flash anthropic/claude-haiku-5.5 --tier economy --apply',
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('deepseek/deepseek-v4-flash: created, 3 new price row(s)');
    expect(result.out).toContain('anthropic/claude-haiku-5.5: created, 8 new price row(s)');
    const model = await prisma.aiModel.findFirstOrThrow({
      where: { modelKey: 'deepseek/deepseek-v4-flash' },
      include: { provider: true, capabilities: true, prices: true },
    });
    expect(model).toMatchObject({ status: 'disabled', qualityTier: 'economy' });
    expect(model.provider).toMatchObject({ key: 'openrouter', status: 'disabled' });
    expect(model.capabilities.map((c) => c.capability)).toEqual(['llm']);
    expect(
      model.prices.every((p) => p.source === 'official_api' && p.sourceUrl === `${baseUrl}/models`),
    ).toBe(true);
  });

  it('is idempotent, and appends a row only for a changed price', async () => {
    expect((await cli('model import-openrouter deepseek/deepseek-v4-flash --apply')).out).toContain(
      'unchanged, 0 new price row(s)',
    );
    const flash = catalog[0] as { pricing: Record<string, string> };
    flash.pricing['prompt'] = '0.00000008';
    const changed = await cli('model import-openrouter deepseek/deepseek-v4-flash --apply');
    expect(changed.out).toContain('updated, 1 new price row(s)');
    expect(changed.out).toContain('input_tokens: 0.00000009 → 0.00000008 USD/unit');
    const rows = await prisma.aiModelPrice.findMany({
      where: { model: { modelKey: 'deepseek/deepseek-v4-flash' }, metric: 'input_tokens' },
    });
    expect(rows).toHaveLength(2); // the old row is kept (append-only)
    flash.pricing['prompt'] = '0.00000009';
    await cli('model import-openrouter deepseek/deepseek-v4-flash --apply'); // restore for later tests
  });

  it.each([
    [
      'a dynamic router',
      {
        id: 'openrouter/auto',
        name: 'Auto',
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '-1', completion: '-1' },
      },
      'dynamic router',
    ],
    [
      'an image-only model',
      {
        id: 'x/image',
        name: 'Img',
        architecture: { output_modalities: ['image'] },
        pricing: { prompt: '0.1', completion: '0.1' },
      },
      'not a text-output model',
    ],
    [
      'a model without token prices',
      {
        id: 'x/noprice',
        name: 'N',
        architecture: { output_modalities: ['text'] },
        pricing: { request: '0.01' },
      },
      'no input/output token price',
    ],
  ])('refuses %s', async (_name, entry, reason) => {
    catalog.push(entry);
    const result = await cli(`model import-openrouter ${entry.id} --tier economy --apply`);
    expect(result.code).toBe(1);
    expect(result.out).toContain(reason);
  });

  it('reports an unreachable catalog clearly, without throwing', async () => {
    const result = await cli('model import-openrouter x/y', {
      OPENROUTER_BASE_URL: 'http://127.0.0.1:1/api/v1',
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'could not reach the OpenRouter catalog at http://127.0.0.1:1/api/v1/models',
    );
  });

  it('reports a model missing from the catalog', async () => {
    expect((await cli('model import-openrouter nobody/nothing')).out).toContain(
      'not in the OpenRouter catalog',
    );
  });
});

describe('circuits (M7b)', () => {
  it('lists, opens and closes a provider circuit, and refuses an unknown provider', async () => {
    const mock = await prisma.aiProvider.upsert({
      where: { key: 'mock' },
      create: { key: 'mock', name: 'Mock', kind: 'mock', status: 'enabled' },
      update: {},
    });
    expect((await cli('circuit list')).out).toMatch(/^mock\tclosed\tfailures=0$/m);
    const opened = await cli('circuit open mock');
    expect([opened.code, opened.out]).toEqual([
      0,
      expect.stringMatching(/^✔ circuit mock is open until /),
    ]);
    expect((await cli('circuit list')).out).toMatch(/^mock\topen\tfailures=0\tretry_at=/m);
    expect((await cli('circuit close mock')).out).toBe('✔ circuit mock is closed');
    const events = await prisma.providerCircuitEvent.findMany({
      where: { providerId: mock.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.toState, e.reason])).toEqual([
      ['open', 'manual'],
      ['closed', 'manual'],
    ]);
    expect((await cli('circuit open nobody')).code).toBe(2);
    expect((await cli('circuit open')).code).toBe(2);
  });
});

describe('status, prices and listing', () => {
  it('enables a model and lists its active prices', async () => {
    expect((await cli('model set-status deepseek/deepseek-v4-flash enabled')).code).toBe(0);
    const list = await cli('model list');
    expect(list.out).toMatch(
      /openrouter\tdeepseek\/deepseek-v4-flash\tenabled\teconomy\t.*input_tokens=0\.00000009/,
    );
  });

  it('appends a manual price and never edits existing rows', async () => {
    const result = await cli(
      'price add deepseek/deepseek-v4-flash request 0.0001 --source manual_estimate --url https://example.test/quote',
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('appended');
    expect((await cli('model list')).out).toContain('request=0.0001');
  });

  it.each([
    'provider set-status openrouter on',
    'model set-status deepseek/deepseek-v4-flash maybe',
    'price add deepseek/deepseek-v4-flash tokens 1 --source manual_estimate --url u',
    'price add deepseek/deepseek-v4-flash request 1 --source guess --url u',
    'model import-openrouter x --tier ultra',
    'nonsense',
  ])('rejects bad usage: %s', async (args) => {
    expect((await cli(args)).code).toBe(2);
  });

  it('reports unknown models and invalid amounts', async () => {
    expect((await cli('model set-status nobody/x enabled')).code).toBe(1);
    expect(
      (
        await cli(
          'price add deepseek/deepseek-v4-flash request abc --source manual_estimate --url u',
        )
      ).err,
    ).toContain('invalid USD amount');
    // A negative amount looks like an option: a usage error, never an uncaught exception.
    expect(
      (
        await cli(
          'price add deepseek/deepseek-v4-flash request -1 --source manual_estimate --url u',
        )
      ).code,
    ).toBe(2);
  });
});

describe('task routes (M3 Q4)', () => {
  it('routes a task to a model, warns while it is disabled, and lists routes', async () => {
    const set = await cli('route set script_generation anthropic/claude-haiku-5.5');
    expect(set.code).toBe(0);
    expect(set.out).toContain('✔ script_generation → openrouter/anthropic/claude-haiku-5.5');
    expect(set.out).toContain('not enabled');
    expect((await cli('route list')).out).toContain(
      'script_generation\topenrouter/anthropic/claude-haiku-5.5\tdisabled',
    );
  });

  it.each(['route set music_generation x', 'route set script_generation'])(
    'rejects bad usage: %s',
    async (args) => {
      expect((await cli(args)).code).toBe(2);
    },
  );

  it('refuses an unknown model', async () => {
    expect((await cli('route set storyboard_generation nobody/nothing')).code).toBe(1);
  });
});

describe('invocations mark-abandoned', () => {
  it('marks only stale started invocations', async () => {
    const result = await cli('invocations mark-abandoned', apiEnv);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/✔ \d+ abandoned invocation\(s\) marked outcome_unknown/);
  });
});

describe('paid smoke test', () => {
  const smoke = (extra = '', env: Record<string, string> = {}) =>
    cli(`smoke deepseek/deepseek-v4-flash --project ${projectSlug} ${extra}`, {
      ...apiEnv,
      ...env,
    });

  it('is refused unless explicitly enabled', async () => {
    const result = await smoke('--max-cost-usd 0.01', { OPENROUTER_API_KEY: KEY });
    expect(result.code).toBe(2);
    expect(result.err).toContain('ACF_PAID_SMOKE=1');
    expect(chatBodies).toHaveLength(0);
  });

  it('is refused without credentials', async () => {
    const result = await smoke('--max-cost-usd 0.01', { ACF_PAID_SMOKE: '1' });
    expect(result.err).toContain('no credentials');
  });

  it('is refused when the worst case exceeds the cap', async () => {
    const result = await smoke('--max-cost-usd 0.000000001', {
      ACF_PAID_SMOKE: '1',
      OPENROUTER_API_KEY: KEY,
    });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/worst case [\d.]+ USD exceeds/);
    expect(chatBodies).toHaveLength(0);
  });

  it('makes one bounded call, records it and prints reported vs estimated cost', async () => {
    const result = await smoke('--max-cost-usd 0.01', {
      ACF_PAID_SMOKE: '1',
      OPENROUTER_API_KEY: KEY,
    });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      max_tokens: SMOKE_MAX_OUTPUT_TOKENS,
    });
    expect(result.out).toContain('reported cost: 0.000001584 USD');
    expect(result.out).toContain('cost status reported');
    const inv = await prisma.aiInvocation.findFirstOrThrow({
      where: { providerRequestId: 'gen-smoke-1' },
    });
    expect(inv.status).toBe('succeeded');
  });
});
