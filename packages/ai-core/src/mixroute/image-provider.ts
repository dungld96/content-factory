import { z } from 'zod';

import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import {
  parseImageRequest,
  type GeneratedImage,
  type ImageAspectRatio,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from '../media.js';
import {
  MIXROUTE_PROVIDER_KEY,
  mixRouteEndpoint,
  mixRouteHeaders,
  type MixRouteConfig,
} from './config.js';
import { callSignal, mixRouteRejection, refuseZeroDataRetention } from './errors.js';
import { generateGeminiImage, isGeminiImageModel } from './gemini-image.js';

/**
 * MixRoute Seedream adapter (P5 decision G8; verification record §3). `POST /images/generations`,
 * synchronous, top-level fields. Seedream has no aspect-ratio field: the adapter sends an explicit
 * `widthxheight` from {@link SEEDREAM_SIZES}. One image per call (`n` does not control the count),
 * no seed. Images come back as base64 (`response_format: b64_json`): no URL is fetched.
 */

/** Resolution tiers the adapter can send; every size is ≤ 2,610,000 px (the "std" price tier). */
export const SEEDREAM_RESOLUTIONS = ['1.5K', '2K'] as const;
type SeedreamResolution = (typeof SEEDREAM_RESOLUTIONS)[number];

/**
 * Explicit sizes (documented range 921,600–4,624,220 total pixels). Long side = tier, except 1:1
 * at 2K, held at 1600×1600 so it stays in the standard price tier (2048×2048 = 4.19 MP would be
 * billed at the "hd" price).
 */
export const SEEDREAM_SIZES: Readonly<
  Record<SeedreamResolution, Readonly<Record<ImageAspectRatio, string>>>
> = {
  '1.5K': { '9:16': '864x1536', '1:1': '1536x1536', '16:9': '1536x864' },
  '2K': { '9:16': '1152x2048', '1:1': '1600x1600', '16:9': '2048x1152' },
};

/** Documented reference limit for generation. */
export const SEEDREAM_MAX_REFERENCES = 10;

export const mixRouteImageResponseSchema = z.object({
  created: z.number().optional(),
  model: z.string().optional(),
  data: z.array(
    z.object({
      b64_json: z.string().min(1).optional(),
      url: z.string().optional(),
      size: z.string().optional(),
      output_format: z.string().optional(),
    }),
  ),
  usage: z
    .object({
      input_images: z.number().int().nonnegative().optional(),
      generated_images: z.number().int().nonnegative().optional(),
    })
    .nullable()
    .optional(),
});
export type MixRouteImageResponse = z.infer<typeof mixRouteImageResponseSchema>;

function notSent(message: string): ProviderError {
  return new ProviderError(ProviderErrorCode.INVALID_REQUEST, message, {
    outcome: ProviderErrorOutcome.NOT_SENT,
  });
}

/** Builds the Seedream body. Exported for contract tests. */
export function buildSeedreamBody(request: ImageRequest): Record<string, unknown> {
  if (request.count !== 1) throw notSent('Seedream on MixRoute returns one image per call');
  if (request.seed !== undefined) throw notSent('Seedream on MixRoute does not take a seed');
  if (request.references.length > SEEDREAM_MAX_REFERENCES) {
    throw notSent(`Seedream takes at most ${String(SEEDREAM_MAX_REFERENCES)} reference images`);
  }
  const resolution = request.resolution ?? '2K';
  const sizes = (SEEDREAM_SIZES as Partial<Record<string, Record<ImageAspectRatio, string>>>)[
    resolution
  ];
  if (!sizes) throw notSent(`resolution ${resolution} is not supported`);
  const body: Record<string, unknown> = {
    model: request.modelKey,
    prompt: request.prompt,
    size: sizes[request.aspectRatio],
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
  };
  if (request.references.length > 0) {
    const urls = request.references.map(
      (r) => `data:${r.mimeType};base64,${Buffer.from(r.bytes).toString('base64')}`,
    );
    body['image'] = urls.length === 1 ? urls[0] : urls;
  }
  return body;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_PREFIX = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i;

export class MixRouteImageProvider implements ImageProvider {
  readonly providerKey = MIXROUTE_PROVIDER_KEY;
  readonly capability = 'image_generation' as const;
  private readonly endpoint: string;

  constructor(private readonly config: MixRouteConfig) {
    this.endpoint = mixRouteEndpoint(config, '/images/generations');
  }

  async generate(
    input: ImageRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<ImageResult> {
    // Gemini image models use the native generateContent format (verification record §3b).
    if (isGeminiImageModel(input.modelKey)) {
      return generateGeminiImage(this.config, input, context, signal);
    }
    const request = parseImageRequest(input);
    if (request.dataPolicy?.zeroDataRetention) throw refuseZeroDataRetention();
    const body = JSON.stringify(buildSeedreamBody(request));
    const combined = callSignal(signal, context.deadlineAt, this.config.timeoutMs);

    const started = performance.now();
    let response: Response;
    let raw: string;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: mixRouteHeaders(this.config),
        body,
        signal: combined,
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      // MixRoute does not say whether a disconnected image call is billed: unknown (M2 rule).
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
    return this.result(raw, latencyMs, request.references.length);
  }

  private result(raw: string, latencyMs: number, referenceCount: number): ImageResult {
    const failed = (code: ProviderErrorCode, message: string, cause?: unknown) =>
      new ProviderError(code, message, {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        reportedCost: null,
        ...(cause === undefined ? {} : { cause }),
      });
    let body: MixRouteImageResponse;
    try {
      const parsed = mixRouteImageResponseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw parsed.error;
      body = parsed.data;
    } catch (cause) {
      throw failed(ProviderErrorCode.MALFORMED_RESPONSE, 'unparseable image response', cause);
    }
    // "Unsuccessful outputs are not charged" (verification record §3): count what came back.
    if (body.data.length === 0) {
      throw failed(ProviderErrorCode.EMPTY_OUTPUT, 'no images in the response');
    }
    const images: GeneratedImage[] = [];
    for (const item of body.data) {
      if (item.b64_json === undefined) {
        throw failed(ProviderErrorCode.MALFORMED_RESPONSE, 'image has no b64_json');
      }
      const prefix = DATA_URL_PREFIX.exec(item.b64_json);
      const b64 = item.b64_json.slice(prefix?.[0].length ?? 0).replace(/\s+/g, '');
      if (!BASE64.test(b64)) {
        throw failed(ProviderErrorCode.MALFORMED_RESPONSE, 'image is not base64');
      }
      images.push({
        declaredType:
          prefix?.[1] ?? (item.output_format ? `image/${item.output_format}` : 'image/png'),
        bytes: new Uint8Array(Buffer.from(b64, 'base64')),
      });
    }
    return {
      images,
      usage: {
        outputImages: body.usage?.generated_images ?? images.length,
        inputImages: body.usage?.input_images ?? referenceCount,
        outputPixels: null, // set by the caller after decoding the images
        inputPixels: null,
        outputTokens: null,
        inputTokens: null,
      },
      reportedCost: null,
      providerRequestId: null,
      servedModel: body.model ?? null,
      latencyMs,
    };
  }
}
