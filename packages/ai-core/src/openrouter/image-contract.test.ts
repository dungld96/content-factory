// Contract tests for the OpenRouter Image API adapter (M4 design §3.2, §9) against a local HTTP
// fixture server: the real `fetch` path, request shape, and every response class.
//
// FIXTURES ARE DERIVED FROM THE DOCUMENTED SCHEMAS (docs/design/m4/openrouter-image-verification.md,
// retrieved 2026-11-18), not recorded from live traffic. The manual smoke run records real
// responses to extend them.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GenerationContext } from '../capability.js';
import { ProviderError } from '../errors.js';
import type { ImageRequest } from '../media.js';
import { mockPng } from '../testing/mock-image.js';
import { buildImageBody, OpenRouterImageProvider } from './image-provider.js';

interface Scripted {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}
interface Received {
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
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      const next = script.shift() ?? { status: 500, body: { error: { code: 500, message: 'x' } } };
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
  qualityTier: 'balanced',
};
const png = mockPng(9, 16, 1);
const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  modelKey: 'bytedance-seed/seedream-5-0-flash',
  prompt: 'A tidy desk with three gadgets, morning light',
  aspectRatio: '9:16',
  count: 1,
  references: [],
  ...over,
});
const provider = (timeoutMs = 5000) =>
  new OpenRouterImageProvider({ apiKey: API_KEY, baseUrl, timeoutMs });
const ok = (data: unknown[], usage: unknown = { completion_tokens: 4175, cost: 0.018 }) => ({
  status: 200,
  body: { created: 1_763_400_000, data, usage },
});
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function expectProviderError(promise: Promise<unknown>): Promise<ProviderError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('request', () => {
  it('posts the documented body to /images with only the parameters in use', async () => {
    script.push(ok([{ b64_json: b64(png), media_type: 'image/png' }]));
    await provider().generate(
      request({
        resolution: '2K',
        seed: 7,
        count: 2,
        references: [{ mimeType: 'image/png', bytes: png }],
        dataPolicy: { zeroDataRetention: true },
      }),
      context,
      new AbortController().signal,
    );
    const sent = received[0];
    expect(sent?.url).toBe('/api/v1/images');
    expect(sent?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(sent?.body).toEqual({
      model: 'bytedance-seed/seedream-5-0-flash',
      prompt: 'A tidy desk with three gadgets, morning light',
      aspect_ratio: '9:16',
      n: 2,
      resolution: '2K',
      seed: 7,
      input_references: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64(png)}` } },
      ],
      provider: { data_collection: 'deny', zdr: true },
    });
  });

  it('omits n, resolution, seed and references when unused; never sends secrets in the body', () => {
    const body = buildImageBody(request());
    expect(Object.keys(body).sort()).toEqual(['aspect_ratio', 'model', 'prompt', 'provider']);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('validates before sending', async () => {
    const error = await expectProviderError(
      provider().generate(request({ count: 9 }), context, new AbortController().signal),
    );
    expect([error.code, error.outcome]).toEqual(['INVALID_REQUEST', 'not_sent']);
    expect(received).toHaveLength(0);
  });
});

describe('response', () => {
  it('decodes images, keeps the declared type, and reports cost and tokens', async () => {
    script.push(
      ok(
        [
          { b64_json: b64(png), media_type: 'image/png' },
          { b64_json: b64(png) }, // media_type omitted when unidentifiable
        ],
        { prompt_tokens: 12, completion_tokens: 4175, total_tokens: 4187, cost: 0.036 },
      ),
    );
    const result = await provider().generate(
      request({ count: 2 }),
      context,
      new AbortController().signal,
    );
    expect(result.images.map((i) => i.declaredType)).toEqual(['image/png', null]);
    expect(result.images[0]?.bytes).toEqual(png);
    expect(result.reportedCost?.toString()).toBe('0.036');
    expect(result.usage).toMatchObject({ outputImages: 2, outputTokens: 4175, inputTokens: 12 });
  });

  it('treats a missing cost as not reported (never zero)', async () => {
    script.push(ok([{ b64_json: b64(png), media_type: 'image/png' }], { completion_tokens: 10 }));
    const result = await provider().generate(request(), context, new AbortController().signal);
    expect(result.reportedCost).toBeNull();
  });

  it.each([
    ['no images', ok([]), 'EMPTY_OUTPUT'],
    ['not base64', ok([{ b64_json: '***' }]), 'MALFORMED_RESPONSE'],
    ['not JSON', { status: 200, body: '<html>' }, 'MALFORMED_RESPONSE'],
    ['negative cost', ok([{ b64_json: b64(png) }], { cost: -1 }), 'MALFORMED_RESPONSE'],
  ] as const)('fails after acceptance: %s', async (_label, scripted, code) => {
    script.push(scripted);
    const error = await expectProviderError(
      provider().generate(request(), context, new AbortController().signal),
    );
    expect([error.code, error.outcome]).toEqual([code, 'failed_after_acceptance']);
  });
});

describe('errors (classified like the chat API)', () => {
  it.each([
    [
      400,
      { error: { code: 400, message: 'bad', metadata: { error_type: 'invalid_request' } } },
      'INVALID_REQUEST',
      false,
    ],
    [401, { error: { code: 401, message: 'no key' } }, 'AUTHENTICATION', false],
    [402, { error: { code: 402, message: 'credits' } }, 'PROVIDER_BUDGET_EXCEEDED', false],
    [
      403,
      {
        error: {
          code: 403,
          message: 'blocked',
          metadata: { error_type: 'content_policy_violation' },
        },
      },
      'CONTENT_POLICY',
      false,
    ],
    [429, { error: { code: 429, message: 'slow down' } }, 'RATE_LIMITED', true],
    // A failed generation: 502 and not billed (verification record §1).
    [502, { error: { code: 502, message: 'generation failed' } }, 'PROVIDER_UNAVAILABLE', true],
    [524, { error: { code: 524, message: 'edge timeout' } }, 'PROVIDER_ERROR', true],
  ] as const)('HTTP %i → %s', async (status, body, code, retryable) => {
    script.push({ status, body, headers: status === 429 ? { 'retry-after': '3' } : {} });
    const error = await expectProviderError(
      provider().generate(request(), context, new AbortController().signal),
    );
    expect([error.code, error.retryable, error.outcome]).toEqual([code, retryable, 'rejected']);
    if (status === 429) expect(error.retryAfterMs).toBe(3000);
    expect(error.message).not.toContain(API_KEY);
  });

  it('reports a timeout as outcome unknown', async () => {
    script.push({ ...ok([{ b64_json: b64(png) }]), delayMs: 500 });
    const error = await expectProviderError(
      provider(100).generate(request(), context, new AbortController().signal),
    );
    expect([error.code, error.outcome]).toEqual(['TIMEOUT', 'unknown']);
  });
});
