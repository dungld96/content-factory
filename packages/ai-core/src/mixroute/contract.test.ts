// Contract tests for the MixRoute adapters (P5a) against a local HTTP fixture server: the real
// `fetch` path, request shape and headers, and every response class.
//
// FIXTURES ARE DERIVED FROM THE DOCUMENTED SCHEMAS (docs/design/p5/mixroute-verification.md,
// retrieved 2026-11-26), not recorded from live traffic. The first manual smoke run records real
// responses to extend them.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GenerationContext } from '../capability.js';
import { ProviderError } from '../errors.js';
import type { LlmRequest } from '../llm.js';
import type { ImageRequest } from '../media.js';
import { buildGeminiImageBody } from './gemini-image.js';
import { buildSeedreamBody, MixRouteImageProvider } from './image-provider.js';
import { checkMixRouteKey } from './key-check.js';
import { MixRouteLlmProvider } from './llm-provider.js';

interface Scripted {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}
interface Received {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown> | null;
}

const API_KEY = 'sk-0123456789abcdef0123456789abcdef';
let server: Server;
let baseUrl: string;
const script: Scripted[] = [];
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });
      const next = script.shift() ?? { status: 500, body: { error: { message: 'unscripted' } } };
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
        res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
      }, next.delayMs ?? 0);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
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

async function rejectionOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected a rejection');
}

// ------------------------------------------------------------------------------------- text

const llmRequest: LlmRequest = {
  modelKey: 'gemini-3.5-flash-lite',
  messages: [
    { role: 'system', content: 'You write scripts.' },
    { role: 'user', content: 'A 30 s script about tea.' },
  ],
  maxOutputTokens: 800,
  temperature: 0.7,
  responseFormat: {
    type: 'json_schema',
    name: 'Script',
    schema: { type: 'object', properties: { title: { type: 'string' } } },
    strict: true,
  },
};

const completion = {
  id: 'chatcmpl-123',
  object: 'chat.completion',
  created: 1764115200,
  model: 'gemini-3.5-flash-lite',
  choices: [
    { index: 0, message: { role: 'assistant', content: '{"title":"Tea"}' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
};

describe('MixRouteLlmProvider', () => {
  const provider = () => new MixRouteLlmProvider({ apiKey: API_KEY, baseUrl, timeoutMs: 5_000 });

  it('sends an OpenAI chat completion with a bearer key and parses the result', async () => {
    script.push({ status: 200, body: completion });
    const result = await provider().complete(llmRequest, context, new AbortController().signal);

    const req = received[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/v1/chat/completions');
    expect(req?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req?.body).toEqual({
      model: 'gemini-3.5-flash-lite',
      messages: llmRequest.messages,
      max_tokens: 800,
      stream: false,
      temperature: 0.7,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Script',
          strict: true,
          schema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      },
    });
    // No OpenRouter routing preferences leak into a MixRoute request.
    expect(req?.body).not.toHaveProperty('provider');
    expect(result).toMatchObject({
      text: '{"title":"Tea"}',
      finishReason: 'stop',
      providerRequestId: 'chatcmpl-123',
      servedModel: 'gemini-3.5-flash-lite',
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, reasoningTokens: 0 },
      // MixRoute reports no cost: the ledger records the registry estimate.
      reportedCost: null,
    });
  });

  it('counts cached and reasoning tokens when the response breaks them down', async () => {
    script.push({
      status: 200,
      body: {
        ...completion,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 60 },
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      },
    });
    const result = await provider().complete(llmRequest, context, new AbortController().signal);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 0,
      reasoningTokens: 25,
    });
  });

  it.each([
    [
      401,
      {
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      'AUTHENTICATION',
    ],
    [403, { error: { message: 'Token Group Disabled' } }, 'PROVIDER_BUDGET_EXCEEDED'],
    [400, { error: { message: 'bad parameter' } }, 'INVALID_REQUEST'],
    [404, '<html>not found</html>', 'MODEL_NOT_FOUND'],
    [429, { error: { message: 'model traffic limit' } }, 'RATE_LIMITED'],
    [503, { error: { message: 'Model Unavailable' } }, 'PROVIDER_UNAVAILABLE'],
    [504, { error: { message: 'gateway timeout' } }, 'TIMEOUT'],
    [500, { error: { message: 'internal' } }, 'PROVIDER_ERROR'],
  ])('classifies HTTP %i as %s (rejected, not charged)', async (status, body, code) => {
    script.push({ status, body, headers: { 'retry-after': '7' } });
    const error = await rejectionOf(
      provider().complete(llmRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe(code);
    expect(error.outcome).toBe('rejected');
    expect(error.httpStatus).toBe(status);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it('turns a content filter stop into CONTENT_POLICY after acceptance', async () => {
    script.push({
      status: 200,
      body: {
        ...completion,
        choices: [{ index: 0, message: { content: '' }, finish_reason: 'content_filter' }],
      },
    });
    const error = await rejectionOf(
      provider().complete(llmRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe('CONTENT_POLICY');
    expect(error.outcome).toBe('failed_after_acceptance');
    expect(error.usage?.inputTokens).toBe(120);
  });

  it.each([
    ['no choices', { ...completion, choices: [] }, 'MALFORMED_RESPONSE'],
    ['no usage', { ...completion, usage: null }, 'MALFORMED_RESPONSE'],
    [
      'empty text',
      { ...completion, choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
      'EMPTY_OUTPUT',
    ],
    ['not JSON', 'oops', 'MALFORMED_RESPONSE'],
  ])('fails after acceptance on %s', async (_name, body, code) => {
    script.push({ status: 200, body });
    const error = await rejectionOf(
      provider().complete(llmRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe(code);
    expect(error.outcome).toBe('failed_after_acceptance');
  });

  it('records a timeout as an unknown outcome (the call may have been charged)', async () => {
    script.push({ status: 200, body: completion, delayMs: 500 });
    const slow = new MixRouteLlmProvider({ apiKey: API_KEY, baseUrl, timeoutMs: 50 });
    const error = await rejectionOf(
      slow.complete(llmRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe('TIMEOUT');
    expect(error.outcome).toBe('unknown');
  });

  it('refuses a zero-data-retention request without sending it', async () => {
    const error = await rejectionOf(
      provider().complete(
        { ...llmRequest, dataPolicy: { zeroDataRetention: true } },
        context,
        new AbortController().signal,
      ),
    );
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.outcome).toBe('not_sent');
    expect(received).toHaveLength(0);
  });

  it('never puts the key in an error message', async () => {
    script.push({ status: 401, body: { error: { message: `bad key ${API_KEY}` } } });
    const error = await rejectionOf(
      provider().complete(llmRequest, context, new AbortController().signal),
    );
    expect(error.message).not.toContain(API_KEY);
  });
});

// ------------------------------------------------------------------------------------ image

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const imageRequest: ImageRequest = {
  modelKey: 'doubao-seedream-5-5-261028',
  prompt: 'A cup of green tea on a wooden table',
  aspectRatio: '9:16',
  resolution: '2K',
  count: 1,
  references: [{ mimeType: 'image/png', bytes: new Uint8Array(PNG) }],
};

describe('buildSeedreamBody', () => {
  it('maps the ratio and tier to an explicit size in the standard price tier', () => {
    expect(buildSeedreamBody(imageRequest)).toMatchObject({
      model: 'doubao-seedream-5-5-261028',
      size: '1152x2048',
      output_format: 'png',
      response_format: 'b64_json',
      watermark: false,
      image: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    for (const ratio of ['9:16', '1:1', '16:9'] as const) {
      for (const resolution of ['1.5K', '2K'] as const) {
        const size = buildSeedreamBody({ ...imageRequest, aspectRatio: ratio, resolution })['size'];
        const [w, h] = String(size).split('x').map(Number);
        expect((w ?? 0) * (h ?? 0)).toBeGreaterThanOrEqual(921_600);
        expect((w ?? 0) * (h ?? 0)).toBeLessThanOrEqual(2_610_000);
      }
    }
  });

  it('defaults to 2K, sends several references as an array, and none when there are none', () => {
    const two = { mimeType: 'image/png' as const, bytes: new Uint8Array(PNG) };
    expect(
      buildSeedreamBody({ ...imageRequest, resolution: undefined, references: [two, two] }),
    ).toMatchObject({ size: '1152x2048', image: [expect.any(String), expect.any(String)] });
    expect(buildSeedreamBody({ ...imageRequest, references: [] })).not.toHaveProperty('image');
  });

  it.each([
    ['two images', { count: 2 }],
    ['a seed', { seed: 7 }],
    ['an unsupported tier', { resolution: '4K' as const }],
  ])('refuses %s before sending', (_name, change) => {
    expect(() => buildSeedreamBody({ ...imageRequest, ...change })).toThrow(ProviderError);
  });
});

describe('MixRouteImageProvider', () => {
  const provider = () => new MixRouteImageProvider({ apiKey: API_KEY, baseUrl, timeoutMs: 5_000 });

  it('posts to /images/generations and decodes the base64 image', async () => {
    script.push({
      status: 200,
      body: {
        created: 1764115200,
        data: [{ b64_json: PNG.toString('base64'), size: '1152x2048', output_format: 'png' }],
        usage: { input_images: 1, generated_images: 1 },
      },
    });
    const result = await provider().generate(imageRequest, context, new AbortController().signal);
    expect(received[0]?.url).toBe('/v1/images/generations');
    expect(received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0]?.bytes ?? []).equals(PNG)).toBe(true);
    expect(result.images[0]?.declaredType).toBe('image/png');
    expect(result.usage).toMatchObject({ outputImages: 1, inputImages: 1 });
    expect(result.reportedCost).toBeNull();
  });

  it('accepts a data-URL b64_json', async () => {
    script.push({
      status: 200,
      body: { data: [{ b64_json: `data:image/jpeg;base64,${PNG.toString('base64')}` }] },
    });
    const result = await provider().generate(
      { ...imageRequest, references: [] },
      context,
      new AbortController().signal,
    );
    expect(result.images[0]?.declaredType).toBe('image/jpeg');
    expect(result.usage.inputImages).toBe(0);
  });

  it.each([
    ['no images', { data: [] }, 'EMPTY_OUTPUT'],
    [
      'a URL instead of base64',
      { data: [{ url: 'https://cdn.example/x.png' }] },
      'MALFORMED_RESPONSE',
    ],
    ['invalid base64', { data: [{ b64_json: '***' }] }, 'MALFORMED_RESPONSE'],
  ])('fails after acceptance on %s', async (_name, body, code) => {
    script.push({ status: 200, body });
    const error = await rejectionOf(
      provider().generate(imageRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe(code);
    expect(error.outcome).toBe('failed_after_acceptance');
  });

  it('classifies a rejected request', async () => {
    script.push({ status: 400, body: { error: { message: 'prompt is required' } } });
    const error = await rejectionOf(
      provider().generate(imageRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.outcome).toBe('rejected');
  });
});

// -------------------------------------------------------------------------------- key check

describe('checkMixRouteKey', () => {
  const config = () => ({ apiKey: API_KEY, baseUrl, timeoutMs: 5_000 });

  it.each([
    [200, 'valid'],
    [401, 'rejected'],
    [403, 'rejected'],
    [500, 'unreachable'],
  ] as const)('HTTP %i → %s, reading the free model list', async (status, result) => {
    script.push({ status, body: { object: 'list', data: [] } });
    const check = await checkMixRouteKey(config());
    expect(received[0]?.method).toBe('GET');
    expect(received[0]?.url).toBe('/v1/models');
    expect(check).toEqual({
      result,
      httpStatus: status,
      limitRemaining: null,
      usage: null,
      isFreeTier: null,
    });
  });

  it('reports an unreachable gateway', async () => {
    const check = await checkMixRouteKey({ ...config(), baseUrl: 'http://127.0.0.1:1/v1' });
    expect(check.result).toBe('unreachable');
  });
});

// ------------------------------------------------------------------------- Gemini image (§3b)

describe('Gemini image models on MixRoute', () => {
  const provider = () => new MixRouteImageProvider({ apiKey: API_KEY, baseUrl, timeoutMs: 5_000 });
  const gemini: ImageRequest = {
    ...imageRequest,
    modelKey: 'gemini-2.5-flash-image',
    resolution: undefined,
  };

  it('builds a native generateContent body with the aspect ratio and inline references', () => {
    expect(buildGeminiImageBody(gemini)).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            { text: gemini.prompt },
            { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '9:16' },
      },
    });
    expect(() => buildGeminiImageBody({ ...gemini, resolution: '2K' })).toThrow(ProviderError);
    expect(() => buildGeminiImageBody({ ...gemini, count: 2 })).toThrow(ProviderError);
  });

  it('posts to /v1beta/models/{model}:generateContent and decodes the inline image', async () => {
    script.push({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'thinking', thought: true },
                { text: 'Here is your image' },
                { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 270, candidatesTokenCount: 1290 },
        modelVersion: 'gemini-2.5-flash-image',
        responseId: 'resp-1',
      },
    });
    const result = await provider().generate(gemini, context, new AbortController().signal);
    expect(received[0]?.url).toBe('/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(Buffer.from(result.images[0]?.bytes ?? []).equals(PNG)).toBe(true);
    expect(result).toMatchObject({
      providerRequestId: 'resp-1',
      reportedCost: null,
      usage: { outputImages: 1, inputImages: 1, outputTokens: 1290, inputTokens: 270 },
    });
  });

  it.each([
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'CONTENT_POLICY'],
    [{ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] }, 'CONTENT_POLICY'],
    [
      { candidates: [{ content: { parts: [{ text: 'no image' }] }, finishReason: 'STOP' }] },
      'EMPTY_OUTPUT',
    ],
  ])('fails after acceptance when no image comes back (%#)', async (body, code) => {
    script.push({ status: 200, body });
    const error = await rejectionOf(
      provider().generate(gemini, context, new AbortController().signal),
    );
    expect(error.code).toBe(code);
    expect(error.outcome).toBe('failed_after_acceptance');
  });
});

describe('MixRoute error shapes seen live (2026-11-26)', () => {
  const provider = () => new MixRouteLlmProvider({ apiKey: API_KEY, baseUrl, timeoutMs: 5_000 });

  it.each([
    [
      500,
      {
        error: {
          message: 'contents is required',
          type: 'mixroute_error',
          param: '',
          code: 'invalid_request',
        },
      },
      'INVALID_REQUEST',
    ],
    [
      503,
      {
        error: {
          code: 'model_not_found',
          message: 'No available channel for model x under group free',
          type: 'mixroute_error',
        },
      },
      'MODEL_NOT_FOUND',
    ],
  ])('HTTP %i %o is never retried', async (status, body, code) => {
    script.push({ status, body });
    const error = await rejectionOf(
      provider().complete(llmRequest, context, new AbortController().signal),
    );
    expect(error.code).toBe(code);
  });
});
