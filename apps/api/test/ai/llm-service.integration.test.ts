// LlmService against the real registry and ledger (design package §7.4), with deterministic mock
// adapters in place of vendor adapters. No network: the mocks never call one, and the network
// guard would fail the test if anything tried.
import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  UsdAmount,
  type GenerationContext,
  type LlmProvider,
  type LlmRequest,
} from '@acf/ai-core';
import { MockLlmProvider } from '@acf/ai-core/testing';
import type { PrismaClient } from '@acf/database';

import { ABANDONED_ERROR_CODE, LlmService, ModelCatalog, RoutingError } from '@acf/ai-runtime';
import { seedAiRegistry } from '../../src/cli/seed-ai.js';
import { authTestEnv, inspector, resetDatabase, userAdmin } from '../support/auth-app.js';
import { seedUsers } from '../support/workspace.js';

let db: pg.Client;
let prisma: PrismaClient;
let projectId: string;
let contentItemId: string;
let mock: MockLlmProvider;
let openrouter: MockLlmProvider; // stands in for the OpenRouter adapter (priced models)
let llm: LlmService;

function service(providers: ReadonlyMap<string, LlmProvider>): LlmService {
  return new LlmService(prisma, new ModelCatalog(prisma, providers), providers, {
    providerTimeoutMs: authTestEnv().OPENROUTER_TIMEOUT_MS,
  });
}

const context = (overrides: Partial<GenerationContext> = {}): GenerationContext => ({
  projectId,
  contentItemId,
  correlationId: `corr-${randomUUID()}`,
  qualityTier: 'economy',
  ...overrides,
});
const ask = (modelKey: string, extra: Partial<LlmRequest> = {}): LlmRequest => ({
  modelKey,
  messages: [
    { role: 'system', content: 'SYSTEM PROMPT SECRET' },
    { role: 'user', content: 'USER BRIEF SECRET' },
  ],
  maxOutputTokens: 64,
  ...extra,
});
const invocationOf = (ctx: GenerationContext) =>
  prisma.aiInvocation.findFirstOrThrow({
    where: { correlationId: ctx.correlationId },
    include: { usageRecords: { orderBy: { metric: 'asc' } }, model: true },
  });

beforeAll(async () => {
  db = await inspector();
  await resetDatabase(db);
  const admin = userAdmin();
  prisma = admin.prisma;
  const ids = await seedUsers(admin.users);
  projectId = randomUUID();
  contentItemId = randomUUID();
  await db.query(`BEGIN;
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${projectId}', 'AI', 'ai-${projectId.slice(0, 8)}', 'vi', 'UTC', '${ids['owner'] ?? ''}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at)
      VALUES ('${projectId}', '${ids['owner'] ?? ''}', 'owner', now());
    INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at)
      VALUES ('${contentItemId}', '${projectId}', 'C', '{}', 'vi', '${ids['owner'] ?? ''}', now());
    INSERT INTO content_items (id, project_id, content_master_id, title, format, target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at)
      VALUES ('${contentItemId}', '${projectId}', '${contentItemId}', 'C', 'short_video', 30, '9:16', 'vi', '{}', '${ids['owner'] ?? ''}', now());
    COMMIT`);
  await seedAiRegistry(prisma, { openrouterConfigured: false });
  // Enable the gateway and one priced model for routing tests.
  await prisma.aiProvider.update({ where: { key: 'openrouter' }, data: { status: 'enabled' } });
  await prisma.aiModel.updateMany({
    where: { modelKey: { in: ['deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5'] } },
    data: { status: 'enabled' },
  });
});

beforeEach(() => {
  mock = new MockLlmProvider({ providerKey: 'mock' });
  openrouter = new MockLlmProvider({ providerKey: 'openrouter' });
  llm = service(
    new Map<string, LlmProvider>([
      ['mock', mock],
      ['openrouter', openrouter],
    ]),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

describe('successful calls', () => {
  it('persists intent, outcome and exact estimated cost from the registry prices', async () => {
    openrouter.enqueue({
      kind: 'result',
      text: 'hook',
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    const ctx = context();
    const result = await llm.complete(ctx, ask('deepseek/deepseek-v4-flash', { seed: 7 }));
    expect(result.text).toBe('hook');

    const inv = await invocationOf(ctx);
    expect(inv).toMatchObject({
      status: 'succeeded',
      projectId,
      contentItemId,
      capability: 'llm',
      costStatus: 'estimated',
      reportedCost: null,
      finishReason: 'stop',
      providerRequestId: 'openrouter-1',
      servedModel: 'deepseek/deepseek-v4-flash',
      errorCode: null,
    });
    expect(inv.model.modelKey).toBe('deepseek/deepseek-v4-flash');
    expect(inv.completedAt).not.toBeNull();
    // 1000 × 0.09e-6 + 500 × 0.18e-6 = 0.00018
    expect(UsdAmount.parse(inv.estimatedCost?.toFixed() ?? 'x').toString()).toBe('0.00018');
    expect(inv.usageRecords.map((u) => [u.metric, Number(u.quantity), u.cost?.toFixed()])).toEqual([
      ['input_tokens', 1000, '0.00009'],
      ['output_tokens', 500, '0.00009'],
    ]);
    expect(
      inv.usageRecords.every((u) => u.priceId !== null && u.source === 'provider_reported'),
    ).toBe(true);
  });

  it('records a reported cost as reported and keeps the estimate', async () => {
    openrouter.enqueue({
      kind: 'result',
      usage: { inputTokens: 1000, outputTokens: 500 },
      reportedCost: UsdAmount.parse('0.00015'),
    });
    const ctx = context();
    await llm.complete(ctx, ask('deepseek/deepseek-v4-flash'));
    const inv = await invocationOf(ctx);
    expect(inv.costStatus).toBe('reported');
    expect(UsdAmount.parse(inv.reportedCost?.toFixed() ?? 'x').toString()).toBe('0.00015');
    expect(UsdAmount.parse(inv.estimatedCost?.toFixed() ?? 'x').toString()).toBe('0.00018');
  });

  it('uses the prompt-size tier price', async () => {
    openrouter.enqueue({ kind: 'result', usage: { inputTokens: 100_000, outputTokens: 1000 } });
    const ctx = context();
    await llm.complete(ctx, ask('anthropic/claude-haiku-5.5'));
    const inv = await invocationOf(ctx);
    // tier ≥100k: 100000 × 0.5e-6 + 1000 × 2.5e-6 = 0.0525
    expect(UsdAmount.parse(inv.estimatedCost?.toFixed() ?? 'x').toString()).toBe('0.0525');
  });

  it('records unknown cost (never zero) when a billed metric has no price', async () => {
    mock.enqueue({
      kind: 'result',
      usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
    });
    const ctx = context();
    await llm.complete(ctx, ask('mock/echo'));
    const inv = await invocationOf(ctx);
    expect(inv.costStatus).toBe('unknown');
    expect(inv.estimatedCost).toBeNull();
    expect(inv.usageRecords.find((u) => u.metric === 'cached_input_tokens')).toMatchObject({
      unitPrice: null,
      cost: null,
      priceId: null,
    });
  });

  it('stores parameters and routing, never message content', async () => {
    const ctx = context();
    await llm.complete(
      ctx,
      ask('mock/echo', {
        responseFormat: {
          type: 'json_schema',
          name: 'script',
          strict: true,
          schema: { type: 'object' },
        },
      }),
    );
    const inv = await invocationOf(ctx);
    expect(inv.requestSummary).toEqual({
      modelKey: 'mock/echo',
      messageCount: 2,
      maxOutputTokens: 64,
      responseFormat: { type: 'json_schema', name: 'script', strict: true },
      zeroDataRetention: false,
      routing: ['mock/echo (mock): eligible'],
    });
    expect(
      JSON.stringify(inv, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain('SECRET');
  });
});

describe('failed calls', () => {
  it('records a rejection with its normalized code and no usage', async () => {
    openrouter.enqueue({
      kind: 'error',
      error: new ProviderError(ProviderErrorCode.RATE_LIMITED, 'Rate limit exceeded', {
        outcome: ProviderErrorOutcome.REJECTED,
        retryAfterMs: 1000,
      }),
    });
    const ctx = context();
    await expect(llm.complete(ctx, ask('deepseek/deepseek-v4-flash'))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    const inv = await invocationOf(ctx);
    expect(inv).toMatchObject({
      status: 'failed',
      errorCode: 'RATE_LIMITED',
      errorMessage: 'Rate limit exceeded',
      costStatus: 'unknown',
      usageRecords: [],
    });
  });

  it('records the usage of a failure after acceptance, which may be charged', async () => {
    openrouter.enqueue({
      kind: 'error',
      error: new ProviderError(ProviderErrorCode.EMPTY_OUTPUT, 'empty completion', {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        providerRequestId: 'gen-9',
        usage: {
          inputTokens: 1000,
          outputTokens: 64,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 64,
        },
        reportedCost: UsdAmount.parse('0.0000812'),
      }),
    });
    const ctx = context();
    await expect(llm.complete(ctx, ask('deepseek/deepseek-v4-flash'))).rejects.toBeInstanceOf(
      ProviderError,
    );
    const inv = await invocationOf(ctx);
    expect(inv).toMatchObject({
      status: 'failed',
      errorCode: 'EMPTY_OUTPUT',
      providerRequestId: 'gen-9',
      costStatus: 'reported',
    });
    expect(inv.usageRecords.map((u) => [u.metric, Number(u.quantity)])).toEqual([
      ['input_tokens', 1000],
      ['output_tokens', 64],
    ]);
  });

  it('records an unknown outcome (timeout after sending) as outcome_unknown', async () => {
    openrouter.enqueue({
      kind: 'error',
      error: new ProviderError(ProviderErrorCode.TIMEOUT, 'request timed out', {
        outcome: ProviderErrorOutcome.UNKNOWN,
      }),
    });
    const ctx = context();
    await expect(llm.complete(ctx, ask('deepseek/deepseek-v4-flash'))).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(await invocationOf(ctx)).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'TIMEOUT',
    });
  });

  it('records an unexpected adapter failure as INTERNAL_ERROR and rethrows it', async () => {
    const broken: LlmProvider = {
      providerKey: 'mock',
      supportedParameters: mock.supportedParameters,
      complete: () => Promise.reject(new Error('bug with Bearer sk-or-v1-0123456789abcdef in it')),
    };
    const ctx = context();
    await expect(
      service(new Map([['mock', broken]])).complete(ctx, ask('mock/echo')),
    ).rejects.toThrow('bug');
    const inv = await invocationOf(ctx);
    expect(inv).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' });
    expect(inv.errorMessage).not.toContain('sk-or-v1');
  });

  it('rejects an invalid request before routing: nothing recorded', async () => {
    const ctx = context();
    await expect(llm.complete(ctx, ask('mock/echo', { maxOutputTokens: 0 }))).rejects.toMatchObject(
      {
        code: 'INVALID_REQUEST',
        outcome: 'not_sent',
      },
    );
    expect(await prisma.aiInvocation.count({ where: { correlationId: ctx.correlationId } })).toBe(
      0,
    );
  });
});

describe('routing', () => {
  it.each<[string, () => LlmService, LlmRequest, string]>([
    ['disabled model', () => llm, ask('google/gemini-3.5-flash-lite'), 'model_not_enabled'],
    ['unknown model', () => llm, ask('nobody/nothing'), 'not registered'],
    [
      'missing parameter (Haiku has no seed)',
      () => llm,
      ask('anthropic/claude-haiku-5.5', { seed: 1 }),
      'missing: seed',
    ],
    [
      'provider without credentials',
      () => service(new Map([['mock', mock]])),
      ask('deepseek/deepseek-v4-flash'),
      'provider_not_configured',
    ],
  ])('refuses: %s, records nothing and calls no provider', async (_name, make, request, reason) => {
    const ctx = context();
    const error = await make()
      .complete(ctx, request)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).message).toContain(reason);
    expect(openrouter.calls).toHaveLength(0);
    expect(await prisma.aiInvocation.count({ where: { correlationId: ctx.correlationId } })).toBe(
      0,
    );
  });

  it('refuses a model below the requested quality tier', async () => {
    await expect(
      llm.complete(context({ qualityTier: 'premium' }), ask('mock/echo')),
    ).rejects.toThrow('below_quality_tier');
  });

  it('routes a disabled model only for the operator smoke path', async () => {
    const ctx = context();
    await llm.complete(ctx, ask('google/gemini-3.5-flash-lite'), { allowDisabled: true });
    expect((await invocationOf(ctx)).status).toBe('succeeded');
  });

  it('enforces a unique idempotency key per attempt', async () => {
    await llm.complete(context(), ask('mock/echo'), { idempotencyKey: 'job-1:1' });
    await expect(
      llm.complete(context(), ask('mock/echo'), { idempotencyKey: 'job-1:1' }),
    ).rejects.toThrow();
    expect(mock.calls).toHaveLength(1); // the duplicate never reached the provider
  });
});

describe('abandoned invocations', () => {
  it('marks only invocations past every deadline as outcome_unknown', async () => {
    const recent = context();
    const old = context();
    const model = await prisma.aiModel.findFirstOrThrow({ where: { modelKey: 'mock/echo' } });
    const base = {
      projectId,
      capability: 'llm' as const,
      providerId: model.providerId,
      modelId: model.id,
      requestSummary: {},
    };
    await prisma.aiInvocation.create({ data: { ...base, correlationId: recent.correlationId } });
    await prisma.aiInvocation.create({
      data: {
        ...base,
        correlationId: old.correlationId,
        startedAt: new Date(Date.now() - 3_600_000),
      },
    });
    expect(await llm.markAbandoned()).toBe(1);
    expect(await invocationOf(old)).toMatchObject({
      status: 'outcome_unknown',
      errorCode: ABANDONED_ERROR_CODE,
    });
    expect((await invocationOf(recent)).status).toBe('started');
  });

  it('leaves video invocations alone: they stay started while the provider job is polled (M5)', async () => {
    const video = context();
    const model = await prisma.aiModel.findFirstOrThrow({ where: { modelKey: 'mock/echo' } });
    await prisma.aiInvocation.create({
      data: {
        projectId,
        capability: 'video_generation',
        providerId: model.providerId,
        modelId: model.id,
        requestSummary: {},
        correlationId: video.correlationId,
        startedAt: new Date(Date.now() - 3_600_000),
      },
    });
    expect(await llm.markAbandoned()).toBe(0);
    expect((await invocationOf(video)).status).toBe('started');
  });
});
