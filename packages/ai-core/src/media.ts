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

// ----------------------------------------------------------------------------- video (M5)

/** Resolution tiers the pipeline requests (verification record `docs/design/m5/…` §1). */
export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export const VIDEO_ASPECT_RATIOS = IMAGE_ASPECT_RATIOS;

export const VIDEO_LIMITS = {
  maxPromptChars: 4000,
  maxDurationSeconds: 30,
  maxFrameBytes: 20 * 1024 * 1024,
} as const;

/** Validated before any network call (M5 design §3.1). */
export const videoRequestSchema = z
  .object({
    modelKey: z.string().min(1).max(200),
    prompt: z.string().trim().min(1).max(VIDEO_LIMITS.maxPromptChars),
    /** One of the model's supported durations (see {@link chooseVideoDuration}). */
    durationSeconds: z.number().int().min(1).max(VIDEO_LIMITS.maxDurationSeconds),
    resolution: z.enum(VIDEO_RESOLUTIONS),
    aspectRatio: z.enum(VIDEO_ASPECT_RATIOS),
    /** Default false: voice-over comes from TTS (decision V4). */
    generateAudio: z.boolean(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .optional(),
    /** The approved keyframe, sent as the first frame (image-to-video). */
    firstFrame: referenceSchema
      .refine((r) => r.bytes.byteLength <= VIDEO_LIMITS.maxFrameBytes, 'first frame too large')
      .optional(),
  })
  .strict();
export type VideoRequest = z.infer<typeof videoRequestSchema>;

/** @throws {ProviderError} `INVALID_REQUEST`, outcome `not_sent`. */
export function parseVideoRequest(input: unknown): VideoRequest {
  const result = videoRequestSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ProviderError(
      ProviderErrorCode.INVALID_REQUEST,
      `invalid video request: ${fields.join(', ')}`,
      { outcome: ProviderErrorOutcome.NOT_SENT },
    );
  }
  return result.data;
}

/** Normalized provider job states (OpenRouter: pending, in_progress, completed, …). */
export const VideoJobStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;
export type VideoJobStatus = (typeof VideoJobStatus)[keyof typeof VideoJobStatus];
export const TERMINAL_VIDEO_STATUSES: ReadonlySet<VideoJobStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

/** A provider job, as accepted at submit or as seen on a poll. */
export interface VideoJobState {
  readonly providerJobId: string;
  readonly status: VideoJobStatus;
  /** The provider's error text (failed/cancelled/expired); safe to show, never the prompt. */
  readonly error: string | null;
  /** Provider-reported cost; known once completed (null = not reported). */
  readonly reportedCost: UsdAmount | null;
  /** Number of downloadable outputs (completed jobs). */
  readonly outputCount: number;
  /** When the provider's stored copy of the outputs stops being downloadable. */
  readonly expiresAt: Date | null;
}

export interface VideoDownload {
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly body: AsyncIterable<Uint8Array>;
}

/**
 * Asynchronous image/text-to-video provider (M5 design §3.1, decision V3): `submit` once, then
 * `poll` until a terminal state, then `download`. Submitting is paid and not idempotent, so the
 * caller persists the returned provider job id before waiting and never resubmits on its own.
 * Implementations validate input, never retry, and throw only {@link ProviderError}.
 */
export interface VideoProvider extends MediaProviderBase<'video_generation'> {
  submit(
    request: VideoRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoJobState>;
  poll(
    providerJobId: string,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoJobState>;
  download(
    providerJobId: string,
    index: number,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<VideoDownload>;
}

/** What a video model accepts (`ai_models.media_constraints`, from the catalog record). */
export interface VideoConstraints {
  readonly kind: 'video';
  readonly durations: readonly number[];
  readonly resolutions: readonly string[];
  readonly aspectRatios: readonly string[];
  readonly frameImages: readonly string[];
  /** Whether the model can generate audio; null = not declared. */
  readonly audio: boolean | null;
  readonly seed: boolean;
  /** Seconds billed at least per clip (operator-set from observed billing); absent = none. */
  readonly minBilledSeconds?: number | undefined;
}

export const videoConstraintsSchema = z
  .object({
    kind: z.literal('video'),
    durations: z.array(z.number().int().min(-1).max(600)).max(64),
    resolutions: z.array(z.string().max(16)).max(16),
    aspectRatios: z.array(z.string().max(16)).max(32),
    frameImages: z.array(z.string().max(32)).max(4),
    audio: z.boolean().nullable(),
    seed: z.boolean(),
    /**
     * Seconds the provider bills at least, whatever the requested duration (observed in the
     * benchmark, e.g. 5 s for Kling v3.0; not in the catalog). Set by the operator; absent = none.
     */
    minBilledSeconds: z.number().int().positive().max(600).optional(),
  })
  .strict();

/**
 * Billed clip length for a scene (decision V5): the smallest supported duration that covers the
 * scene, or `null` when the scene is longer than the model's maximum.
 */
/** Seconds billed for a clip of `durationSeconds` under the model's minimum, if any. */
export function billedVideoSeconds(
  durationSeconds: number,
  constraints: Pick<VideoConstraints, 'minBilledSeconds'> | null,
): number {
  return Math.max(durationSeconds, constraints?.minBilledSeconds ?? 0);
}

export function chooseVideoDuration(
  sceneSeconds: number,
  supported: readonly number[],
): number | null {
  const needed = Math.max(1, Math.ceil(sceneSeconds - 1e-9));
  const fitting = supported.filter((d) => d >= needed).sort((a, b) => a - b);
  return fitting[0] ?? null;
}

export function videoConstraintIssues(
  request: Pick<
    VideoRequest,
    'durationSeconds' | 'resolution' | 'aspectRatio' | 'generateAudio' | 'seed' | 'firstFrame'
  >,
  constraints: VideoConstraints | null,
): string[] {
  if (!constraints) return ['the model has no recorded video constraints (re-import it)'];
  const issues: string[] = [];
  if (!constraints.durations.includes(request.durationSeconds)) {
    issues.push(`duration ${String(request.durationSeconds)} s is not supported`);
  }
  if (!constraints.resolutions.includes(request.resolution)) {
    issues.push(`resolution ${request.resolution} is not supported`);
  }
  if (!constraints.aspectRatios.includes(request.aspectRatio)) {
    issues.push(`aspect ratio ${request.aspectRatio} is not supported`);
  }
  if (request.firstFrame && !constraints.frameImages.includes('first_frame')) {
    issues.push('a first frame image is not supported');
  }
  if (request.generateAudio && constraints.audio === false) {
    issues.push('audio generation is not supported');
  }
  if (request.seed !== undefined && !constraints.seed) issues.push('seed is not supported');
  return issues;
}

// ----------------------------------------------------------------------------- TTS (M5)

export const TTS_LIMITS = { maxChars: 5000, maxInstructionsChars: 500 } as const;

export const ttsRequestSchema = z
  .object({
    modelKey: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(TTS_LIMITS.maxChars),
    /** Provider voice id (model-specific). */
    voice: z.string().trim().min(1).max(200),
    /** BCP 47 tag; used by models that take a language option, else informational. */
    language: z.string().trim().min(2).max(35).optional(),
    speed: z.number().min(0.5).max(2).optional(),
    instructions: z.string().trim().min(1).max(TTS_LIMITS.maxInstructionsChars).optional(),
    /** Restrict routing to zero-data-retention endpoints (decision V2: always on for TTS routes). */
    dataPolicy: z.object({ zeroDataRetention: z.boolean() }).strict().optional(),
  })
  .strict();
export type TtsRequest = z.infer<typeof ttsRequestSchema>;

/** @throws {ProviderError} `INVALID_REQUEST`, outcome `not_sent`. */
export function parseTtsRequest(input: unknown): TtsRequest {
  const result = ttsRequestSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ProviderError(
      ProviderErrorCode.INVALID_REQUEST,
      `invalid TTS request: ${fields.join(', ')}`,
      { outcome: ProviderErrorOutcome.NOT_SENT },
    );
  }
  return result.data;
}

export interface TtsResult {
  /** Encoded audio (MP3, or WAV when the provider only returns PCM). */
  readonly bytes: Uint8Array;
  readonly mimeType: 'audio/mpeg' | 'audio/wav';
  /** Characters billed (the input text length). */
  readonly characters: number;
  readonly reportedCost: UsdAmount | null;
  readonly providerRequestId: string | null;
  readonly latencyMs: number;
}

/** Text-to-speech provider (synchronous). Validates input, never retries, throws ProviderError. */
export interface TtsProvider extends MediaProviderBase<'tts'> {
  synthesize(
    request: TtsRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<TtsResult>;
}

export interface TtsConstraints {
  readonly kind: 'tts';
  /** Voices the catalog lists (empty = not listed: any id is sent as is). */
  readonly voices: readonly string[];
  /** Whether the model can return MP3 (some return PCM only). */
  readonly mp3: boolean;
}

export const ttsConstraintsSchema = z
  .object({
    kind: z.literal('tts'),
    voices: z.array(z.string().max(200)).max(2000),
    mp3: z.boolean(),
  })
  .strict();

export function ttsConstraintIssues(
  request: Pick<TtsRequest, 'voice'>,
  constraints: TtsConstraints | null,
): string[] {
  if (!constraints) return ['the model has no recorded TTS constraints (re-import it)'];
  if (constraints.voices.length > 0 && !constraints.voices.includes(request.voice)) {
    return [`voice ${request.voice} is not offered by the model`];
  }
  return [];
}
