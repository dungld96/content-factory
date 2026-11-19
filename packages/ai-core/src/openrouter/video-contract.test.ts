// Contract tests for the OpenRouter Video and TTS adapters (M5 design §3.2, §4.1, §13) against a
// local HTTP fixture server: the real `fetch` path, request shapes and every response class.
//
// FIXTURES ARE DERIVED FROM THE DOCUMENTED SCHEMAS (docs/design/m5/openrouter-video-tts-
// verification.md, OpenAPI retrieved 2026-11-19), not recorded from live traffic. The manual
// smoke runs record real responses to extend them.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GenerationContext } from '../capability.js';
import { ProviderError } from '../errors.js';
import type { TtsRequest, VideoRequest } from '../media.js';
import { mockPng } from '../testing/mock-image.js';
import { buildSpeechBody, OpenRouterTtsProvider, wavFromPcm } from './tts-provider.js';
import { buildVideoBody, OpenRouterVideoProvider } from './video-provider.js';

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
      const text = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      });
      const next = script.shift() ?? { status: 500, body: { error: { code: 500, message: 'x' } } };
      setTimeout(() => {
        if (res.destroyed) return;
        const binary = next.body instanceof Uint8Array;
        res.writeHead(next.status, {
          'content-type': binary ? 'application/octet-stream' : 'application/json',
          ...next.headers,
        });
        res.end(
          next.body instanceof Uint8Array
            ? Buffer.from(next.body)
            : typeof next.body === 'string'
              ? next.body
              : JSON.stringify(next.body),
        );
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
const frame = mockPng(9, 16, 3);
const video = (over: Partial<VideoRequest> = {}): VideoRequest => ({
  modelKey: 'google/veo-3.1-lite',
  prompt: 'Slow push-in on a tidy desk, morning light',
  durationSeconds: 6,
  resolution: '720p',
  aspectRatio: '9:16',
  generateAudio: false,
  firstFrame: { mimeType: 'image/png', bytes: frame },
  ...over,
});
const videoProvider = (timeoutMs = 2000) =>
  new OpenRouterVideoProvider({ apiKey: API_KEY, baseUrl, timeoutMs });
const signal = () => new AbortController().signal;
const JOB = 'gen-vid-1763530000-abcdefghij0123456789';

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a ProviderError');
}

describe('OpenRouter video: submit', () => {
  it('sends the documented body: first frame as a data URL, explicit silent audio, no training', async () => {
    script.push({
      status: 202,
      body: { id: JOB, polling_url: `${baseUrl}/videos/${JOB}`, status: 'pending' },
    });
    const state = await videoProvider().submit(video(), context, signal());
    expect(state).toEqual({
      providerJobId: JOB,
      status: 'pending',
      error: null,
      reportedCost: null,
      outputCount: 0,
      expiresAt: null,
    });
    const [req] = received;
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/api/v1/videos');
    expect(req?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req?.body).toEqual({
      model: 'google/veo-3.1-lite',
      prompt: 'Slow push-in on a tidy desk, morning light',
      duration: 6,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: false,
      provider: { data_collection: 'deny' },
      frame_images: [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${Buffer.from(frame).toString('base64')}` },
          frame_type: 'first_frame',
        },
      ],
    });
  });

  it('sends a seed only when asked and never a zdr flag (video has no ZDR)', () => {
    expect(buildVideoBody(video({ seed: 7, firstFrame: undefined }))).toMatchObject({ seed: 7 });
    const body = buildVideoBody(video({ firstFrame: undefined }));
    expect(body).not.toHaveProperty('seed');
    expect(body).not.toHaveProperty('frame_images');
    expect(body['provider']).toEqual({ data_collection: 'deny' });
  });

  it('classifies rejections: 400 unsupported value, 402 credits, 429 with Retry-After', async () => {
    script.push({
      status: 400,
      body: { error: { code: 400, message: 'duration must be one of 4, 6, 8' } },
    });
    const invalid = await failure(videoProvider().submit(video(), context, signal()));
    expect([invalid.code, invalid.outcome, invalid.message]).toEqual([
      'INVALID_REQUEST',
      'rejected',
      'duration must be one of 4, 6, 8',
    ]);

    script.push({ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } });
    expect((await failure(videoProvider().submit(video(), context, signal()))).code).toBe(
      'PROVIDER_BUDGET_EXCEEDED',
    );

    script.push({
      status: 429,
      body: { error: { code: 429, message: 'slow down' } },
      headers: { 'retry-after': '12' },
    });
    const limited = await failure(videoProvider().submit(video(), context, signal()));
    expect([limited.code, limited.retryAfterMs]).toEqual(['RATE_LIMITED', 12_000]);
  });

  it('reports a lost or unreadable submit response as outcome unknown (never resubmit)', async () => {
    script.push({ status: 202, body: { id: JOB }, delayMs: 300 });
    const timedOut = await failure(videoProvider(50).submit(video(), context, signal()));
    expect([timedOut.code, timedOut.outcome]).toEqual(['TIMEOUT', 'unknown']);

    script.push({ status: 202, body: 'not json' });
    const garbled = await failure(videoProvider().submit(video(), context, signal()));
    expect([garbled.code, garbled.outcome]).toEqual(['MALFORMED_RESPONSE', 'unknown']);
  });

  it('reports a refused connection as not sent', async () => {
    // A port that was free a moment ago: nothing listens, the connection is refused.
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    await once(probe, 'close');
    const closed = new OpenRouterVideoProvider({
      apiKey: API_KEY,
      baseUrl: `http://127.0.0.1:${String(port)}/api/v1`,
      timeoutMs: 2000,
    });
    const refused = await failure(closed.submit(video(), context, signal()));
    expect([refused.code, refused.outcome]).toEqual(['NETWORK', 'not_sent']);
  });

  it('validates the request before any network call', async () => {
    const bad = await failure(
      videoProvider().submit(video({ durationSeconds: 0 }), context, signal()),
    );
    expect([bad.code, bad.outcome]).toEqual(['INVALID_REQUEST', 'not_sent']);
    expect(received).toHaveLength(0);
  });
});

describe('OpenRouter video: poll and download', () => {
  it('maps every documented status', async () => {
    script.push(
      { status: 200, body: { id: JOB, polling_url: 'x', status: 'in_progress' } },
      {
        status: 200,
        body: {
          id: JOB,
          polling_url: 'x',
          status: 'completed',
          unsigned_urls: [`${baseUrl}/videos/${JOB}/content?index=0`],
          urls: ['https://signed.example/secret'],
          expires_at: 1_763_600_000,
          usage: { cost: 0.18, is_byok: false },
        },
      },
      { status: 200, body: { id: JOB, polling_url: 'x', status: 'failed', error: 'NSFW frame' } },
      {
        status: 200,
        body: {
          id: JOB,
          polling_url: 'x',
          status: 'expired',
          error: 'Job exceeded maximum time to live',
        },
      },
    );
    const provider = videoProvider();
    expect((await provider.poll(JOB, context, signal())).status).toBe('running');
    const done = await provider.poll(JOB, context, signal());
    expect(done).toMatchObject({
      status: 'completed',
      outputCount: 1,
      expiresAt: new Date(1_763_600_000_000),
      error: null,
    });
    expect(done.reportedCost?.toString()).toBe('0.18');
    expect(await provider.poll(JOB, context, signal())).toMatchObject({
      status: 'failed',
      error: 'NSFW frame',
    });
    expect((await provider.poll(JOB, context, signal())).status).toBe('expired');
    expect(received.map((r) => [r.method, r.url])).toEqual(
      Array.from({ length: 4 }, () => ['GET', `/api/v1/videos/${JOB}`]),
    );
  });

  it('rejects an unknown status and a malformed job id', async () => {
    script.push({ status: 200, body: { id: JOB, polling_url: 'x', status: 'queued_somewhere' } });
    expect((await failure(videoProvider().poll(JOB, context, signal()))).code).toBe(
      'MALFORMED_RESPONSE',
    );
    const bad = await failure(videoProvider().poll('../../etc', context, signal()));
    expect([bad.code, bad.outcome]).toEqual(['INVALID_REQUEST', 'not_sent']);
  });

  it('streams the output with the API key', async () => {
    const bytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
    script.push({ status: 200, body: bytes, headers: { 'content-type': 'video/mp4' } });
    const download = await videoProvider().download(JOB, 0, context, signal());
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.body) chunks.push(chunk);
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(bytes);
    expect(download.contentType).toBe('video/mp4');
    expect(received[0]?.url).toBe(`/api/v1/videos/${JOB}/content?index=0`);
    expect(received[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('classifies a failed download (e.g. the output expired)', async () => {
    script.push({ status: 404, body: { error: { code: 404, message: 'output not found' } } });
    const gone = await failure(videoProvider().download(JOB, 0, context, signal()));
    expect([gone.code, gone.outcome]).toEqual(['MODEL_NOT_FOUND', 'rejected']);
  });
});

const tts = (over: Partial<TtsRequest> = {}): TtsRequest => ({
  modelKey: 'elevenlabs/eleven-flash-v2.5',
  text: 'Năm món đồ giúp bàn làm việc gọn gàng hơn.',
  voice: 'sarah',
  dataPolicy: { zeroDataRetention: true },
  ...over,
});
const ttsProvider = (pcmOnly = false, costLookupDelaysMs: readonly number[] = [0]) =>
  new OpenRouterTtsProvider(
    { apiKey: API_KEY, baseUrl, timeoutMs: 2000 },
    () => pcmOnly,
    costLookupDelaysMs,
  );
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 9, 9, 9]);

describe('OpenRouter TTS', () => {
  it('sends the documented body and reads the reported cost from the generation record', async () => {
    script.push(
      {
        status: 200,
        body: mp3,
        headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-tts-1-abc' },
      },
      { status: 200, body: { data: { id: 'gen-tts-1-abc', total_cost: 0.0017 } } },
    );
    const result = await ttsProvider().synthesize(tts({ speed: 1.1 }), context, signal());
    expect(result).toMatchObject({
      bytes: mp3,
      mimeType: 'audio/mpeg',
      characters: Array.from(tts().text).length,
      providerRequestId: 'gen-tts-1-abc',
    });
    expect(result.reportedCost?.toString()).toBe('0.0017');
    expect(received[0]?.url).toBe('/api/v1/audio/speech');
    expect(received[0]?.body).toEqual({
      model: 'elevenlabs/eleven-flash-v2.5',
      input: tts().text,
      voice: 'sarah',
      response_format: 'mp3',
      speed: 1.1,
      provider: { data_collection: 'deny', zdr: true },
    });
    expect(received[1]?.url).toBe('/api/v1/generation?id=gen-tts-1-abc');
  });

  it('keeps going without a reported cost when the generation record is not ready', async () => {
    script.push(
      {
        status: 200,
        body: mp3,
        headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-2' },
      },
      { status: 404, body: { error: { code: 404, message: 'not found' } } },
    );
    expect((await ttsProvider().synthesize(tts(), context, signal())).reportedCost).toBeNull();
  });

  it('retries the cost lookup until the generation record appears', async () => {
    script.push(
      {
        status: 200,
        body: mp3,
        headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-3' },
      },
      { status: 404, body: { error: { code: 404, message: 'not found' } } },
      { status: 200, body: { data: { id: 'gen-3', total_cost: null } } },
      { status: 200, body: { data: { id: 'gen-3', total_cost: 0.002486 } } },
    );
    const result = await ttsProvider(false, [0, 0, 0]).synthesize(tts(), context, signal());
    expect(result.reportedCost?.toString()).toBe('0.002486');
    expect(received.map((r) => r.url)).toEqual([
      '/api/v1/audio/speech',
      '/api/v1/generation?id=gen-3',
      '/api/v1/generation?id=gen-3',
      '/api/v1/generation?id=gen-3',
    ]);
  });

  it('wraps PCM-only output as WAV', async () => {
    const pcm = new Uint8Array(480);
    script.push({ status: 200, body: pcm, headers: { 'content-type': 'audio/pcm' } });
    const result = await ttsProvider(true).synthesize(
      tts({ modelKey: 'google/gemini-3.8-flash-tts', voice: 'Kore' }),
      context,
      signal(),
    );
    expect(result.mimeType).toBe('audio/wav');
    expect(result.bytes).toEqual(wavFromPcm(pcm));
    expect(Buffer.from(result.bytes.subarray(0, 4)).toString('ascii')).toBe('RIFF');
    expect(received[0]?.body?.['response_format']).toBe('pcm');
  });

  it('classifies errors and empty audio', async () => {
    script.push({ status: 400, body: { error: { code: 400, message: 'unknown voice' } } });
    expect((await failure(ttsProvider().synthesize(tts(), context, signal()))).code).toBe(
      'INVALID_REQUEST',
    );
    script.push({ status: 200, body: new Uint8Array(), headers: { 'content-type': 'audio/mpeg' } });
    expect((await failure(ttsProvider().synthesize(tts(), context, signal()))).code).toBe(
      'EMPTY_OUTPUT',
    );
  });

  it('sends instructions only when given, zdr only when required', () => {
    const body = buildSpeechBody(tts({ dataPolicy: undefined }));
    expect(body).not.toHaveProperty('instructions');
    expect(body['provider']).toEqual({ data_collection: 'deny' });
    expect(buildSpeechBody(tts({ instructions: 'calm, warm' }))).toMatchObject({
      instructions: 'calm, warm',
    });
  });
});
