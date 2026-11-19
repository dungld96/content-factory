import { z } from 'zod';

import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import { parseTtsRequest, type TtsProvider, type TtsRequest, type TtsResult } from '../media.js';
import { UsdAmount } from '../money.js';
import { ttsCharacters } from '../pricing.js';
import { OPENROUTER_PROVIDER_KEY, type OpenRouterConfig } from './config.js';
import { rejection } from './http.js';

/**
 * OpenRouter TTS adapter (M5 design §4.1; verification record §2). `POST /audio/speech` returns
 * the raw audio. MP3 is requested; endpoints that only return 16-bit PCM are wrapped as WAV
 * (24 kHz mono, as documented). The reported cost comes from `GET /generation?id=` using the
 * `X-Generation-Id` header; when it is not available yet, the caller falls back to the estimate.
 */

/** Routing preferences for TTS: never train on our data; ZDR per request (decision V2). */
export const OPENROUTER_TTS_PROVIDER_PREFERENCES = { data_collection: 'deny' } as const;

/** PCM format of OpenRouter TTS (TTS guide: 16-bit little-endian, 24 kHz mono). */
export const OPENROUTER_PCM = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 } as const;

/** Builds the `POST /audio/speech` body. Exported for contract tests. */
export function buildSpeechBody(
  request: TtsRequest,
  format: 'mp3' | 'pcm' = 'mp3',
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelKey,
    input: request.text,
    voice: request.voice,
    response_format: format,
    provider: {
      ...OPENROUTER_TTS_PROVIDER_PREFERENCES,
      ...(request.dataPolicy?.zeroDataRetention ? { zdr: true } : {}),
    },
  };
  if (request.speed !== undefined) body['speed'] = request.speed;
  if (request.instructions !== undefined) body['instructions'] = request.instructions;
  return body;
}

/** A WAV container around raw 16-bit PCM. */
export function wavFromPcm(
  pcm: Uint8Array,
  format: { sampleRate: number; channels: number; bitsPerSample: number } = OPENROUTER_PCM,
): Uint8Array {
  const header = Buffer.alloc(44);
  const byteRate = (format.sampleRate * format.channels * format.bitsPerSample) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((format.channels * format.bitsPerSample) / 8, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

const generationSchema = z.object({
  data: z.object({ id: z.string(), total_cost: z.number().nullable().optional() }),
});

export class OpenRouterTtsProvider implements TtsProvider {
  readonly providerKey = OPENROUTER_PROVIDER_KEY;
  readonly capability = 'tts' as const;
  private readonly base: string;

  /** `pcmOnly`: model keys whose endpoints return PCM only (from the registry constraints). */
  constructor(
    private readonly config: OpenRouterConfig,
    private readonly pcmOnly: (modelKey: string) => boolean = () => false,
  ) {
    this.base = config.baseUrl.replace(/\/+$/, '');
  }

  async synthesize(
    input: TtsRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<TtsResult> {
    const request = parseTtsRequest(input);
    const remaining =
      context.deadlineAt === undefined ? Infinity : context.deadlineAt.getTime() - Date.now();
    if (signal.aborted || remaining <= 0) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'deadline passed before sending', {
        outcome: ProviderErrorOutcome.NOT_SENT,
      });
    }
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.min(this.config.timeoutMs, remaining))),
    ]);
    const format = this.pcmOnly(request.modelKey) ? 'pcm' : 'mp3';
    const started = performance.now();
    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await fetch(`${this.base}/audio/speech`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(buildSpeechBody(request, format)),
        signal: combined,
        redirect: 'error',
      });
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new ProviderError(
        combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
        combined.aborted
          ? 'speech request timed out or was aborted'
          : 'network error calling OpenRouter',
        { outcome: ProviderErrorOutcome.UNKNOWN, cause: error },
      );
    }
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) throw rejection(response, Buffer.from(bytes).toString('utf8'));
    const generationId = response.headers.get('x-generation-id');
    if (bytes.byteLength === 0) {
      throw new ProviderError(ProviderErrorCode.EMPTY_OUTPUT, 'no audio in the response', {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        ...(generationId ? { providerRequestId: generationId } : {}),
      });
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    const pcm = type === 'audio/pcm' || type === 'audio/l16' || format === 'pcm';
    return {
      bytes: pcm ? wavFromPcm(bytes) : bytes,
      mimeType: pcm ? 'audio/wav' : 'audio/mpeg',
      characters: ttsCharacters(request.text),
      reportedCost: generationId ? await this.cost(generationId, combined) : null,
      providerRequestId: generationId,
      latencyMs,
    };
  }

  /** The generation's reported cost; null when the record is not available (yet). */
  private async cost(id: string, signal: AbortSignal): Promise<UsdAmount | null> {
    try {
      const response = await fetch(`${this.base}/generation?id=${encodeURIComponent(id)}`, {
        headers: this.headers({ Accept: 'application/json' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        redirect: 'error',
      });
      if (!response.ok) return null;
      const parsed = generationSchema.safeParse(await response.json());
      const cost = parsed.success ? parsed.data.data.total_cost : null;
      return cost === null || cost === undefined ? null : UsdAmount.parse(cost);
    } catch {
      return null;
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...extra,
      ...(this.config.attribution
        ? {
            'HTTP-Referer': this.config.attribution.url,
            'X-OpenRouter-Title': this.config.attribution.title,
          }
        : {}),
    };
  }
}
