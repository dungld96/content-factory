import { z } from 'zod';

import type { Capability, GenerationContext } from './capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from './errors.js';
import type { UsdAmount } from './money.js';

/**
 * Media capability interfaces (ADR-0004). There is deliberately no universal `generate()`:
 * each capability has its own request/result types, designed with its first adapter
 * (image in M4, video and TTS in M5).
 */
interface MediaProviderBase<C extends Capability> {
  readonly providerKey: string;
  readonly capability: C;
}

// ----------------------------------------------------------------------------- image (M4)

/** Aspect ratios the pipeline requests (content items use these three). */
export const IMAGE_ASPECT_RATIOS = ['9:16', '1:1', '16:9'] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/** Normalized resolution tiers (OpenRouter Image API, verification record §1). */
export const IMAGE_RESOLUTIONS = ['512', '768', '1K', '1.5K', '2K', '4K'] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];

export const IMAGE_REFERENCE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Bounds that keep one call reasonable; the model's own limits are checked by the job layer. */
export const IMAGE_LIMITS = {
  maxPromptChars: 8000,
  maxCount: 4,
  maxReferences: 16,
  maxReferenceBytes: 20 * 1024 * 1024,
} as const;

const referenceSchema = z
  .object({
    mimeType: z.enum(IMAGE_REFERENCE_TYPES),
    bytes: z
      .custom<Uint8Array>((value) => value instanceof Uint8Array, 'must be bytes')
      .refine((b) => b.byteLength > 0, 'empty reference image'),
  })
  .strict()
  .refine((r) => r.bytes.byteLength <= IMAGE_LIMITS.maxReferenceBytes, 'reference too large');

/** Validated before any network call; adapters receive only parsed requests. */
export const imageRequestSchema = z
  .object({
    /** Registry model key, e.g. `bytedance-seed/seedream-5-0-flash`. */
    modelKey: z.string().min(1).max(200),
    prompt: z.string().trim().min(1).max(IMAGE_LIMITS.maxPromptChars),
    aspectRatio: z.enum(IMAGE_ASPECT_RATIOS),
    /** Sent only when the model supports it. */
    resolution: z.enum(IMAGE_RESOLUTIONS).optional(),
    /** Images in this call; the job layer splits requests above the model's `n` maximum. */
    count: z.number().int().min(1).max(IMAGE_LIMITS.maxCount),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
    references: z.array(referenceSchema).max(IMAGE_LIMITS.maxReferences),
    /** Restrict routing to zero-data-retention endpoints (decision G9: per route). */
    dataPolicy: z.object({ zeroDataRetention: z.boolean() }).strict().optional(),
  })
  .strict();
export type ImageRequest = z.infer<typeof imageRequestSchema>;
export type ImageReference = ImageRequest['references'][number];

/** @throws {ProviderError} `INVALID_REQUEST`, outcome `not_sent`. */
export function parseImageRequest(input: unknown): ImageRequest {
  const result = imageRequestSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ProviderError(
      ProviderErrorCode.INVALID_REQUEST,
      `invalid image request: ${fields.join(', ')}`,
      { outcome: ProviderErrorOutcome.NOT_SENT },
    );
  }
  return result.data;
}

/** Usage of one image call; `null` = not reported. Quantities are what the provider billed on. */
export interface ImageUsage {
  readonly outputImages: number;
  readonly inputImages: number;
  /** Total output pixels (for per-megapixel prices); computed from the decoded images. */
  readonly outputPixels: number | null;
  readonly inputPixels: number | null;
  /** Image token counts when the provider bills by token (e.g. Google, OpenAI). */
  readonly outputTokens: number | null;
  readonly inputTokens: number | null;
}

export interface GeneratedImage {
  /** As the provider declared it (`media_type`); the caller checks it against the bytes. */
  readonly declaredType: string | null;
  readonly bytes: Uint8Array;
}

export interface ImageResult {
  readonly images: readonly GeneratedImage[];
  readonly usage: ImageUsage;
  /** Provider-reported cost; `null` when not reported. */
  readonly reportedCost: UsdAmount | null;
  /** Provider's id for the call when it returns one (the OpenRouter Image API may not). */
  readonly providerRequestId: string | null;
  readonly servedModel: string | null;
  readonly latencyMs: number;
}

/**
 * Text(+reference images)-to-image provider. Implementations validate input, never retry, and
 * throw only {@link ProviderError}.
 */
export interface ImageProvider extends MediaProviderBase<'image_generation'> {
  generate(
    request: ImageRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<ImageResult>;
}

/** Out of scope in M4 (design §1). */
export type ImageEditProvider = MediaProviderBase<'image_edit'>;
/** M5. */
export type VideoProvider = MediaProviderBase<'video_generation'>;
/** M5. */
export type TtsProvider = MediaProviderBase<'tts'>;

/**
 * What an image model accepts (`ai_models.image_constraints`, from the provider's endpoint
 * record). Empty lists mean "not declared": the parameter is then not sent.
 */
export interface ImageConstraints {
  readonly maxImages: number;
  readonly maxReferences: number;
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  readonly seed: boolean;
}

export const imageConstraintsSchema = z
  .object({
    maxImages: z.number().int().min(1).max(10),
    maxReferences: z.number().int().min(0).max(32),
    aspectRatios: z.array(z.string().max(16)).max(64),
    resolutions: z.array(z.string().max(16)).max(16),
    seed: z.boolean(),
  })
  .strict();

/**
 * Reasons a model cannot serve a request as asked (empty = fits). The job layer splits counts
 * above `maxImages` into several calls before asking (M4 design §3.2).
 */
export function imageConstraintIssues(
  request: Pick<ImageRequest, 'aspectRatio' | 'resolution' | 'count' | 'seed' | 'references'>,
  constraints: ImageConstraints | null,
): string[] {
  if (!constraints) return ['the model has no recorded image constraints (re-import it)'];
  const issues: string[] = [];
  if (request.count > constraints.maxImages) {
    issues.push(
      `count ${String(request.count)} > the model's maximum ${String(constraints.maxImages)}`,
    );
  }
  if (request.references.length > constraints.maxReferences) {
    issues.push(
      `${String(request.references.length)} reference image(s) > the model's maximum ${String(constraints.maxReferences)}`,
    );
  }
  if (
    constraints.aspectRatios.length > 0 &&
    !constraints.aspectRatios.includes(request.aspectRatio)
  ) {
    issues.push(`aspect ratio ${request.aspectRatio} is not supported`);
  }
  if (
    request.resolution !== undefined &&
    (constraints.resolutions.length === 0 || !constraints.resolutions.includes(request.resolution))
  ) {
    issues.push(`resolution ${request.resolution} is not supported`);
  }
  if (request.seed !== undefined && !constraints.seed) issues.push('seed is not supported');
  return issues;
}
