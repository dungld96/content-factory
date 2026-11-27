import { z } from 'zod';

import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import {
  parseImageRequest,
  type GeneratedImage,
  type ImageRequest,
  type ImageResult,
} from '../media.js';
import { mixRouteHeaders, type MixRouteConfig } from './config.js';
import { callSignal, mixRouteRejection, refuseZeroDataRetention } from './errors.js';

/**
 * Gemini image models on MixRoute ("Nano Banana", e.g. `gemini-2.5-flash-image`; verification
 * record §3b). Gemini native `generateContent`: aspect ratio in `generationConfig.imageConfig`,
 * references as `inlineData` parts, the image back as an `inlineData` part. One image per call,
 * no seed, no resolution choice (about 1K output).
 */

export function isGeminiImageModel(modelKey: string): boolean {
  return /^gemini-.*-image/i.test(modelKey) || /nano-banana/i.test(modelKey);
}

/** Native path. The base URL is `…/v1`; Gemini native lives under `/v1beta` (checked live). */
export function geminiImageEndpoint(config: MixRouteConfig, modelKey: string): string {
  const root = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${root}/v1beta/models/${encodeURIComponent(modelKey)}:generateContent`;
}

function notSent(message: string): ProviderError {
  return new ProviderError(ProviderErrorCode.INVALID_REQUEST, message, {
    outcome: ProviderErrorOutcome.NOT_SENT,
  });
}

/** Builds the `generateContent` body. Exported for contract tests. */
export function buildGeminiImageBody(request: ImageRequest): Record<string, unknown> {
  if (request.count !== 1) throw notSent('Gemini image models return one image per call');
  if (request.seed !== undefined) throw notSent('Gemini image models on MixRoute take no seed');
  if (request.resolution !== undefined) {
    throw notSent('Gemini 2.5 image output size is fixed (about 1K): send no resolution');
  }
  const parts: Record<string, unknown>[] = [{ text: request.prompt }];
  for (const r of request.references) {
    parts.push({
      inlineData: { mimeType: r.mimeType, data: Buffer.from(r.bytes).toString('base64') },
    });
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: request.aspectRatio },
    },
  };
}

const partSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  inlineData: z.object({ mimeType: z.string().optional(), data: z.string().min(1) }).optional(),
});

export const geminiImageResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(partSchema).optional() }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
  responseId: z.string().optional(),
});
type GeminiImageResponse = z.infer<typeof geminiImageResponseSchema>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFETY = /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/i;

/** Calls one Gemini image model and normalizes the result (used by MixRouteImageProvider). */
export async function generateGeminiImage(
  config: MixRouteConfig,
  input: ImageRequest,
  context: GenerationContext,
  signal: AbortSignal,
): Promise<ImageResult> {
  const request = parseImageRequest(input);
  if (request.dataPolicy?.zeroDataRetention) throw refuseZeroDataRetention();
  const body = JSON.stringify(buildGeminiImageBody(request));
  const combined = callSignal(signal, context.deadlineAt, config.timeoutMs);

  const started = performance.now();
  let response: Response;
  let raw: string;
  try {
    response = await fetch(geminiImageEndpoint(config, request.modelKey), {
      method: 'POST',
      headers: mixRouteHeaders(config),
      body,
      signal: combined,
      redirect: 'error',
    });
    raw = await response.text();
  } catch (error) {
    throw new ProviderError(
      combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
      combined.aborted
        ? 'image request timed out or was aborted'
        : 'network error calling MixRoute',
      { outcome: ProviderErrorOutcome.UNKNOWN, cause: error },
    );
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) throw mixRouteRejection(response, raw);

  let parsed: GeminiImageResponse;
  try {
    const result = geminiImageResponseSchema.safeParse(JSON.parse(raw));
    if (!result.success) throw result.error;
    parsed = result.data;
  } catch (cause) {
    throw new ProviderError(ProviderErrorCode.MALFORMED_RESPONSE, 'unparseable image response', {
      outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
      reportedCost: null,
      cause,
    });
  }
  const usage = parsed.usageMetadata;
  const providerRequestId = parsed.responseId ?? null;
  const failed = (code: ProviderErrorCode, message: string) =>
    new ProviderError(code, message, {
      outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
      reportedCost: null,
      ...(providerRequestId ? { providerRequestId } : {}),
    });

  const candidate = parsed.candidates?.[0];
  const images: GeneratedImage[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.thought === true || !part.inlineData) continue;
    const b64 = part.inlineData.data.replace(/\s+/g, '');
    if (!BASE64.test(b64))
      throw failed(ProviderErrorCode.MALFORMED_RESPONSE, 'image is not base64');
    images.push({
      declaredType: part.inlineData.mimeType ?? null,
      bytes: new Uint8Array(Buffer.from(b64, 'base64')),
    });
  }
  if (images.length === 0) {
    const reason = parsed.promptFeedback?.blockReason ?? candidate?.finishReason ?? '';
    if (SAFETY.test(reason)) {
      throw failed(ProviderErrorCode.CONTENT_POLICY, `content policy (${reason})`);
    }
    throw failed(
      ProviderErrorCode.EMPTY_OUTPUT,
      `no image in the response (${reason || 'no reason'})`,
    );
  }
  return {
    images: images.slice(0, 1),
    usage: {
      outputImages: 1,
      inputImages: request.references.length,
      outputPixels: null,
      inputPixels: null,
      // Billed by token: $/1M output tokens (verification record §3b).
      outputTokens: usage?.candidatesTokenCount ?? null,
      inputTokens: usage?.promptTokenCount ?? null,
    },
    reportedCost: null,
    providerRequestId,
    servedModel: parsed.modelVersion ?? null,
    latencyMs,
  };
}
