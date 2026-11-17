// Contract tests for the OpenRouter adapter (design package §7, §9) against a local HTTP fixture
// server: the real `fetch` path, request shape and headers, and every response class.
//
// FIXTURES ARE DERIVED FROM THE DOCUMENTED SCHEMAS (docs/design/m2/openrouter-verification.md,
// retrieved 2026-11-17), not recorded from live traffic. The first manual smoke run (M2d) records
// real responses to extend them (risk R2).
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GenerationContext } from '../capability.js';
import { ProviderError } from '../errors.js';
import type { LlmRequest } from '../llm.js';
import { OpenRouterLlmProvider } from './provider.js';

interface Scripted {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  /** Delay before answering, to exercise timeouts. */
  readonly delayMs?: number;
}
interface Received {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

const API_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
let server: Server;
let baseUrl: string;
const script: Scripted[] = [];
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      const next = script.shift() ?? {
        status: 500,
        body: { error: { code: 500, message: 'unscripted' } },
      };
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
        res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
      }, next.delayMs ?? 0);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  script.length = 0;
  received.length = 0;
});

const context: GenerationContext = {
  projectId: '00000000-0000-7000-8000-000000000001',
  correlationId: 'corr-1',
  qualityTier: 'economy',
};
const request: LlmRequest = {
  modelKey: 'deepseek/deepseek-v4-flash',
  messages: [
    { role: 'system', content: 'You write short video hooks.' },
    { role: 'user', content: 'Topic: rainy season in Hanoi.' },
  ],
  maxOutputTokens: 64,
};
const provider = (
  overrides: Partial<ConstructorParameters<typeof OpenRouterLlmProvider>[0]> = {},
) => new OpenRouterLlmProvider({ apiKey: API_KEY, baseUrl, timeoutMs: 5000, ...overrides });
const live = () => new AbortController().signal;

/** A successful completion as documented (`ChatResult`, `ChatUsage`). */
const completion = (
  overrides: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
) => ({
  id: 'gen-1731840000-abc',
  object: 'chat.completion',
  created: 1731840000,
  model: 'deepseek/deepseek-v4-flash-20260423',
  system_fingerprint: null,
  choices: [
    { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Mưa Hà Nội...' } },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 40,
    total_tokens: 160,
    cost: 0.0000144,
    is_byok: false,
    ...usage,
  },
  some_future_field: { ignored: true },
  ...overrides,
});

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a ProviderError');
}

describe('request', () => {
  it('posts the documented shape with routing preferences and bearer auth', async () => {
    script.push({ status: 200, body: completion() });
    await provider().complete(
      {
        ...request,
        temperature: 0.4,
        seed: 7,
        stop: ['END'],
        responseFormat: {
          type: 'json_schema',
          name: 'hook',
          strict: true,
          schema: { type: 'object' },
        },
      },
      context,
      live(),
    );
    const call = received[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/api/v1/chat/completions');
    expect(call?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['http-referer']).toBeUndefined();
    expect(call?.headers['x-openrouter-title']).toBeUndefined();
    expect(call?.body).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      messages: request.messages,
      max_tokens: 64,
      stream: false,
      temperature: 0.4,
      seed: 7,
      stop: ['END'],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'hook', strict: true, schema: { type: 'object' } },
      },
      provider: { data_collection: 'deny', require_parameters: true, allow_fallbacks: true },
    });
    expect(call?.body).not.toHaveProperty('models'); // never a cross-model fallback
  });

  it('sends zdr only when asked, and omits unset optional parameters', async () => {
    script.push({ status: 200, body: completion() });
    await provider().complete(
      { ...request, dataPolicy: { zeroDataRetention: true } },
      context,
      live(),
    );
    expect(received[0]?.body['provider']).toEqual({
      data_collection: 'deny',
      require_parameters: true,
      allow_fallbacks: true,
      zdr: true,
    });
    for (const key of ['temperature', 'top_p', 'seed', 'stop', 'response_format']) {
      expect(received[0]?.body).not.toHaveProperty(key);
    }
  });

  it('sends attribution headers only when configured', async () => {
    script.push({ status: 200, body: completion() });
    await provider({ attribution: { url: 'https://studio.example', title: 'Studio' } }).complete(
      request,
      context,
      live(),
    );
    expect(received[0]?.headers['http-referer']).toBe('https://studio.example');
    expect(received[0]?.headers['x-openrouter-title']).toBe('Studio');
  });

  it('validates the request before any network call', async () => {
    const error = await failure(
      provider().complete({ ...request, maxOutputTokens: 0 }, context, live()),
    );
    expect(error).toMatchObject({ code: 'INVALID_REQUEST', outcome: 'not_sent' });
    expect(received).toHaveLength(0);
  });

  it('does not send after the deadline or an abort', async () => {
    const past = { ...context, deadlineAt: new Date(Date.now() - 1) };
    expect(await failure(provider().complete(request, past, live()))).toMatchObject({
      code: 'TIMEOUT',
      outcome: 'not_sent',
    });
    const controller = new AbortController();
    controller.abort();
    expect(await failure(provider().complete(request, context, controller.signal))).toMatchObject({
      code: 'TIMEOUT',
      outcome: 'not_sent',
    });
    expect(received).toHaveLength(0);
  });
});

describe('success', () => {
  it('normalizes text, finish reason, ids, usage and reported cost', async () => {
    script.push({ status: 200, body: completion() });
    const result = await provider().complete(request, context, live());
    expect(result).toMatchObject({
      text: 'Mưa Hà Nội...',
      finishReason: 'stop',
      providerRequestId: 'gen-1731840000-abc',
      servedModel: 'deepseek/deepseek-v4-flash-20260423',
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(result.reportedCost?.toString()).toBe('0.0000144');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('maps cached, cache-write and reasoning token breakdowns', async () => {
    script.push({
      status: 200,
      body: completion(
        {},
        {
          prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      ),
    });
    const result = await provider().complete(request, context, live());
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 100,
      cacheWriteTokens: 5,
      reasoningTokens: 30,
    });
  });

  it('keeps every token when a breakdown exceeds its total (A1/A2 not holding)', async () => {
    script.push({
      status: 200,
      body: completion(
        {},
        {
          prompt_tokens: 10,
          prompt_tokens_details: { cached_tokens: 50 },
          completion_tokens: 5,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      ),
    });
    const { usage } = await provider().complete(request, context, live());
    expect(usage).toMatchObject({
      inputTokens: 60,
      cachedInputTokens: 50,
      outputTokens: 25,
      reasoningTokens: 20,
    });
  });

  it('treats a null cost as not reported (never zero)', async () => {
    script.push({ status: 200, body: completion({}, { cost: null }) });
    expect((await provider().complete(request, context, live())).reportedCost).toBeNull();
  });

  it('returns a truncated completion as finish reason length', async () => {
    const body = completion();
    body.choices = [
      { index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'cut' } },
    ];
    script.push({ status: 200, body });
    expect((await provider().complete(request, context, live())).finishReason).toBe('length');
  });

  it('joins text content parts', async () => {
    const body = completion();
    body.choices = [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ] as never,
        },
      },
    ];
    script.push({ status: 200, body });
    expect((await provider().complete(request, context, live())).text).toBe('ab');
  });
});

describe('rejections (non-2xx)', () => {
  const err = (code: number, message: string, metadata?: Record<string, unknown>) => ({
    error: { code, message, ...(metadata ? { metadata } : {}) },
  });

  it.each<[string, Scripted, string, boolean]>([
    [
      '401 invalid key',
      { status: 401, body: err(401, 'No auth credentials found') },
      'AUTHENTICATION',
      false,
    ],
    [
      '402 credits',
      { status: 402, body: err(402, 'Insufficient credits') },
      'PROVIDER_BUDGET_EXCEEDED',
      false,
    ],
    [
      '402 weight exceeds budget',
      {
        status: 402,
        body: err(402, 'too large', {
          reason: 'weight_exceeds_budget',
          limit_source: 'openrouter_credits',
        }),
      },
      'PROVIDER_BUDGET_EXCEEDED',
      false,
    ],
    [
      '402 in-flight budget (transient)',
      {
        status: 402,
        body: err(402, 'in flight', {
          reason: 'in_flight_budget_exhausted',
          limit_source: 'openrouter_in_flight_budget',
        }),
        headers: { 'retry-after': '3' },
      },
      'RATE_LIMITED',
      true,
    ],
    [
      '403 guardrail budget',
      {
        status: 403,
        body: err(403, 'Budget limit exceeded', { limit_source: 'openrouter_guardrail_budget' }),
      },
      'PROVIDER_BUDGET_EXCEEDED',
      false,
    ],
    [
      '403 key limit',
      { status: 403, body: err(403, 'Key limit', { limit_source: 'openrouter_key_limit' }) },
      'PROVIDER_BUDGET_EXCEEDED',
      false,
    ],
    [
      '403 guardrail block',
      { status: 403, body: err(403, 'Request blocked', { patterns: ['x'] }) },
      'PERMISSION_DENIED',
      false,
    ],
    [
      '403 moderation',
      {
        status: 403,
        body: err(403, 'flagged', {
          reasons: ['violence'],
          flagged_input: 'PROMPT TEXT',
          provider_name: 'X',
          model_slug: 'm',
        }),
      },
      'CONTENT_POLICY',
      false,
    ],
    [
      '400 context length',
      { status: 400, body: err(400, 'too long', { error_type: 'context_length_exceeded' }) },
      'CONTEXT_LENGTH_EXCEEDED',
      false,
    ],
    [
      '400 invalid request',
      { status: 400, body: err(400, 'bad param', { error_type: 'invalid_request' }) },
      'INVALID_REQUEST',
      false,
    ],
    [
      '404 model',
      { status: 404, body: err(404, 'No such model', { error_type: 'not_found' }) },
      'MODEL_NOT_FOUND',
      false,
    ],
    ['408 timeout', { status: 408, body: err(408, 'timeout') }, 'TIMEOUT', true],
    [
      '429 rate limit with Retry-After',
      {
        status: 429,
        body: err(429, 'Rate limit exceeded', {
          error_type: 'rate_limit_exceeded',
          provider_code: 'rate_limited',
        }),
        headers: { 'retry-after': '60' },
      },
      'RATE_LIMITED',
      true,
    ],
    [
      '500 masked server error',
      { status: 500, body: err(500, 'Internal Server Error', { error_type: 'server' }) },
      'PROVIDER_ERROR',
      true,
    ],
    [
      '502 provider down',
      { status: 502, body: err(502, 'down', { error_type: 'provider_unavailable' }) },
      'PROVIDER_UNAVAILABLE',
      true,
    ],
    [
      '503 no eligible provider',
      { status: 503, body: err(503, 'No endpoints') },
      'PROVIDER_UNAVAILABLE',
      true,
    ],
    [
      '504 non-JSON gateway page',
      { status: 504, body: '<html>Gateway Timeout</html>' },
      'TIMEOUT',
      true,
    ],
    ['418 unknown 4xx', { status: 418, body: err(418, 'teapot') }, 'INVALID_REQUEST', false],
    [
      'unknown error_type falls back to status',
      { status: 429, body: err(429, 'new kind', { error_type: 'brand_new_type' }) },
      'RATE_LIMITED',
      true,
    ],
  ])('%s → %s', async (_name, scripted, code, retryable) => {
    script.push(scripted);
    const error = await failure(provider().complete(request, context, live()));
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.outcome).toBe('rejected');
    expect(error.httpStatus).toBe(scripted.status);
  });

  it('honours Retry-After (seconds) and exposes the provider codes', async () => {
    script.push({
      status: 429,
      body: {
        error: {
          code: 429,
          message: 'Rate limit exceeded',
          metadata: { error_type: 'rate_limit_exceeded', provider_code: 'rate_limited' },
        },
      },
      headers: { 'retry-after': '60' },
    });
    const error = await failure(provider().complete(request, context, live()));
    expect(error).toMatchObject({
      retryAfterMs: 60_000,
      providerErrorType: 'rate_limit_exceeded',
      providerCode: 'rate_limited',
    });
  });

  it('never carries moderation input or the API key in the error', async () => {
    script.push({
      status: 403,
      body: {
        error: {
          code: 403,
          message: `flagged: PROMPT TEXT (key ${API_KEY})`,
          metadata: { reasons: ['x'], flagged_input: 'PROMPT TEXT' },
        },
      },
    });
    const moderation = await failure(provider().complete(request, context, live()));
    expect(moderation.message).not.toContain('PROMPT TEXT');
    expect(moderation.message).not.toContain(API_KEY);

    script.push({
      status: 400,
      body: { error: { code: 400, message: `bad key Bearer ${API_KEY} ${API_KEY}` } },
    });
    const echoed = await failure(provider().complete(request, context, live()));
    expect(echoed.message).not.toContain(API_KEY);
    expect(echoed.message).toContain('[redacted]');
  });
});

describe('failures after acceptance (HTTP 200)', () => {
  it('a 200 body with only an error is classified and keeps the generation id', async () => {
    script.push({
      status: 200,
      body: {
        id: 'gen-2',
        error: {
          code: 502,
          message: 'Provider disconnected',
          metadata: { error_type: 'provider_unavailable' },
        },
      },
    });
    const error = await failure(provider().complete(request, context, live()));
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      outcome: 'failed_after_acceptance',
      providerRequestId: 'gen-2',
      retryable: true,
    });
  });

  it('a choice with finish_reason error keeps the usage that may be charged', async () => {
    const body = completion({}, { cost: 0.00001 });
    body.choices = [
      {
        index: 0,
        finish_reason: 'error',
        message: { role: 'assistant', content: 'partial output...' },
        error: {
          code: 502,
          message: 'Provider disconnected mid-stream',
          metadata: { error_type: 'provider_unavailable' },
        },
      } as never,
    ];
    script.push({ status: 200, body });
    const error = await failure(provider().complete(request, context, live()));
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.outcome).toBe('failed_after_acceptance');
    expect(error.usage).toMatchObject({ inputTokens: 120, outputTokens: 40 });
    expect(error.reportedCost?.toString()).toBe('0.00001');
  });

  it('content_filter is a CONTENT_POLICY error, never a result', async () => {
    const body = completion();
    body.choices = [
      {
        index: 0,
        finish_reason: 'content_filter',
        message: { role: 'assistant', content: 'partial' },
      },
    ];
    script.push({ status: 200, body });
    const error = await failure(provider().complete(request, context, live()));
    expect(error).toMatchObject({
      code: 'CONTENT_POLICY',
      retryable: false,
      fallbackAllowed: false,
    });
    expect(error.usage).toBeDefined();
  });

  it('a model refusal is a CONTENT_POLICY error', async () => {
    const body = completion();
    body.choices = [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: null, refusal: 'I cannot help.' } as never,
      },
    ];
    script.push({ status: 200, body });
    expect((await failure(provider().complete(request, context, live()))).code).toBe(
      'CONTENT_POLICY',
    );
  });

  it('an empty completion (reasoning ate max_tokens) is EMPTY_OUTPUT with usage', async () => {
    const body = completion(
      {},
      { completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } },
    );
    body.choices = [
      { index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } },
    ];
    script.push({ status: 200, body });
    const error = await failure(provider().complete(request, context, live()));
    expect(error).toMatchObject({ code: 'EMPTY_OUTPUT', outcome: 'failed_after_acceptance' });
    expect(error.usage?.reasoningTokens).toBe(64);
  });

  it.each<[string, unknown]>([
    ['not JSON', 'not json'],
    ['no choices', { id: 'gen-3', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } }],
    [
      'no usage',
      { id: 'gen-4', model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'x' } }] },
    ],
    ['negative cost', completion({}, { cost: -1 })],
    ['negative tokens', completion({}, { prompt_tokens: -1 })],
    ['BYOK (cost is not the full cost)', completion({}, { is_byok: true })],
  ])('%s → MALFORMED_RESPONSE', async (_name, body) => {
    script.push({ status: 200, body });
    const error = await failure(provider().complete(request, context, live()));
    expect(error).toMatchObject({
      code: 'MALFORMED_RESPONSE',
      outcome: 'failed_after_acceptance',
      fallbackAllowed: false,
    });
  });
});

describe('transport', () => {
  it('times out with an unknown outcome (the call may have been charged)', async () => {
    script.push({ status: 200, body: completion(), delayMs: 500 });
    const error = await failure(provider({ timeoutMs: 50 }).complete(request, context, live()));
    expect(error).toMatchObject({ code: 'TIMEOUT', outcome: 'unknown', retryable: true });
  });

  it('honours the context deadline when it is sooner than the timeout', async () => {
    script.push({ status: 200, body: completion(), delayMs: 500 });
    const soon = { ...context, deadlineAt: new Date(Date.now() + 50) };
    expect((await failure(provider().complete(request, soon, live()))).code).toBe('TIMEOUT');
  });

  it('reports a refused connection as NETWORK with an unknown outcome', async () => {
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    await once(closed, 'close');
    const error = await failure(
      provider({ baseUrl: `http://127.0.0.1:${String(port)}/api/v1` }).complete(
        request,
        context,
        live(),
      ),
    );
    expect(error).toMatchObject({ code: 'NETWORK', outcome: 'unknown' });
  });
});

describe('network guard (test-support/network-guard.ts)', () => {
  it('blocks the real OpenRouter host in tests', async () => {
    const error = await failure(
      provider({ baseUrl: 'https://openrouter.ai/api/v1' }).complete(request, context, live()),
    );
    expect(error.code).toBe('NETWORK');
    expect((error.cause as Error).message).toContain('network guard');
  });
});
