import { z } from 'zod';

import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import {
  parseImageRequest,
  type GeneratedImage,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from '../media.js';
import { MoneyError, UsdAmount } from '../money.js';
import { OPENROUTER_PROVIDER_KEY, type OpenRouterConfig } from './config.js';
import { classifyOpenRouterError, parseRetryAfter } from './errors.js';
import { openRouterErrorBodySchema, type OpenRouterErrorObject } from './schema.js';

/**
 * OpenRouter Image API adapter (M4 design §3.2; verification record
 * `docs/design/m4/openrouter-image-verification.md`). `POST /images`, synchronous: images come
 * back base64-encoded in the response. Billing is all-or-nothing (a failed generation answers
 * `502` and is not billed). Never retries, never logs.
 */

/** Response of `POST /images` (unknown fields ignored: OpenRouter ships additive changes). */
export const openRouterImageResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  created: z.number().optional(),
  data: z.array(
    z.object({
      b64_json: z.string().min(1),
      media_type: z.string().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type OpenRouterImageResponse = z.infer<typeof openRouterImageResponseSchema>;

/** Routing preferences for image calls (decision G9): never train on our data. */
export const OPENROUTER_IMAGE_PROVIDER_PREFERENCES = { data_collection: 'deny' } as const;

/** Builds the `POST /images` body. Exported for contract tests. */
export function buildImageBody(request: ImageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelKey,
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    provider: {
      ...OPENROUTER_IMAGE_PROVIDER_PREFERENCES,
      ...(request.dataPolicy?.zeroDataRetention ? { zdr: true } : {}),
    },
  };
  // Only parameters the request uses: absent keys are "unsupported" for many endpoints.
  if (request.count > 1) body['n'] = request.count;
  if (request.resolution !== undefined) body['resolution'] = request.resolution;
  if (request.seed !== undefined) body['seed'] = request.seed;
  if (request.references.length > 0) {
    body['input_references'] = request.references.map((r) => ({
      type: 'image_url',
      image_url: { url: `data:${r.mimeType};base64,${Buffer.from(r.bytes).toString('base64')}` },
    }));
  }
  return body;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class OpenRouterImageProvider implements ImageProvider {
  readonly providerKey = OPENROUTER_PROVIDER_KEY;
  readonly capability = 'image_generation' as const;
  private readonly endpoint: string;

  constructor(private readonly config: OpenRouterConfig) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/images`;
  }

  async generate(
    input: ImageRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<ImageResult> {
    const request = parseImageRequest(input);
    const remaining =
      context.deadlineAt === undefined ? Infinity : context.deadlineAt.getTime() - Date.now();
    if (signal.aborted || remaining <= 0) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'deadline passed before sending', {
        outcome: ProviderErrorOutcome.NOT_SENT,
      });
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.config.timeoutMs, remaining)));
    const combined = AbortSignal.any([signal, timeout]);

    const started = performance.now();
    let response: Response;
    let raw: string;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.config.attribution
            ? {
                'HTTP-Referer': this.config.attribution.url,
                'X-OpenRouter-Title': this.config.attribution.title,
              }
            : {}),
        },
        body: JSON.stringify(buildImageBody(request)),
        signal: combined,
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      // Billing is all-or-nothing and a disconnect is never billed to us (verification record
      // §1), but the client cannot see the outcome: record it as unknown (M2 rule).
      throw new ProviderError(
        combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
        combined.aborted
          ? 'image request timed out or was aborted'
          : 'network error calling OpenRouter',
        { outcome: ProviderErrorOutcome.UNKNOWN, cause: error },
      );
    }
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) throw this.rejection(response, raw);
    return this.result(raw, latencyMs, response.headers.get('x-generation-id'));
  }

  private rejection(response: Response, raw: string): ProviderError {
    let error: OpenRouterErrorObject | undefined;
    try {
      const parsed = openRouterErrorBodySchema.safeParse(JSON.parse(raw));
      if (parsed.success) error = parsed.data.error;
    } catch {
      // Not JSON: classify by status alone.
    }
    const classified = classifyOpenRouterError(response.status, error);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new ProviderError(classified.code, classified.message, {
      // A failed generation (502) is not billed: nothing was charged.
      outcome: ProviderErrorOutcome.REJECTED,
      httpStatus: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(classified.providerErrorType === undefined
        ? {}
        : { providerErrorType: classified.providerErrorType }),
      ...(classified.providerCode === undefined ? {} : { providerCode: classified.providerCode }),
    });
  }

  private result(raw: string, latencyMs: number, headerId: string | null): ImageResult {
    let body: OpenRouterImageResponse;
    try {
      const parsed = openRouterImageResponseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw parsed.error;
      body = parsed.data;
    } catch (cause) {
      throw new ProviderError(ProviderErrorCode.MALFORMED_RESPONSE, 'unparseable image response', {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        cause,
      });
    }
    const providerRequestId = body.id ?? headerId ?? null;
    let reportedCost: UsdAmount | null;
    try {
      const cost = body.usage?.cost;
      reportedCost = cost === null || cost === undefined ? null : UsdAmount.parse(cost);
    } catch (cause) {
      if (!(cause instanceof MoneyError)) throw cause;
      throw new ProviderError(ProviderErrorCode.MALFORMED_RESPONSE, 'invalid usage.cost', {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        cause,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }
    if (body.data.length === 0) {
      throw new ProviderError(ProviderErrorCode.EMPTY_OUTPUT, 'no images in the response', {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        reportedCost,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }
    const images: GeneratedImage[] = [];
    for (const item of body.data) {
      const b64 = item.b64_json.replace(/\s+/g, '');
      if (!BASE64.test(b64)) {
        throw new ProviderError(ProviderErrorCode.MALFORMED_RESPONSE, 'image is not base64', {
          outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
          reportedCost,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }
      images.push({
        declaredType: item.media_type ?? null,
        bytes: new Uint8Array(Buffer.from(b64, 'base64')),
      });
    }
    return {
      images,
      usage: {
        outputImages: images.length,
        inputImages: 0, // set by the caller, which knows how many references it sent
        outputPixels: null, // set by the caller after decoding the images
        inputPixels: null,
        outputTokens: body.usage?.completion_tokens ?? null,
        inputTokens: body.usage?.prompt_tokens ?? null,
      },
      reportedCost,
      providerRequestId,
      servedModel: body.model ?? null,
      latencyMs,
    };
  }
}
