import type { UsdAmount } from './money.js';

/** Billable metrics of a model price (ADR-0012; `ai_model_prices.metric`). */
export const PriceMetric = {
  INPUT_TOKENS: 'input_tokens',
  OUTPUT_TOKENS: 'output_tokens',
  CACHED_INPUT_TOKENS: 'cached_input_tokens',
  CACHE_WRITE_TOKENS: 'cache_write_tokens',
  REASONING_TOKENS: 'reasoning_tokens',
  REQUEST: 'request',
  // Image generation (M4; verification record §1: per image, per megapixel, per image token).
  OUTPUT_IMAGES: 'output_images',
  INPUT_IMAGES: 'input_images',
  /** Per-megapixel prices are stored per pixel so quantities stay integers. */
  OUTPUT_PIXELS: 'output_pixels',
  INPUT_PIXELS: 'input_pixels',
  OUTPUT_IMAGE_TOKENS: 'output_image_tokens',
  INPUT_IMAGE_TOKENS: 'input_image_tokens',
  // Video and TTS (M5; docs/design/m5/openrouter-video-tts-verification.md).
  /** USD per output second; `variant` = resolution and audio (see `videoPriceVariants`). */
  OUTPUT_VIDEO_SECONDS: 'output_video_seconds',
  /** Video models billed by token: recorded, but no estimate is possible before the call. */
  OUTPUT_VIDEO_TOKENS: 'output_video_tokens',
  /** TTS priced per input character. */
  INPUT_CHARACTERS: 'input_characters',
} as const;
export type PriceMetric = (typeof PriceMetric)[keyof typeof PriceMetric];

/**
 * Token usage of one LLM call, as the provider reported it. Totals include their breakdowns:
 * `inputTokens` includes `cachedInputTokens` (assumption A1) and `outputTokens` includes
 * `reasoningTokens` (assumption A2). Cost assessment splits them only when a separate price exists.
 */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export const CostStatus = {
  /** The provider reported the call's cost. */
  REPORTED: 'reported',
  /** No reported cost; every billed metric had a known price. */
  ESTIMATED: 'estimated',
  /** No reported cost and at least one billed metric had no price. Never shown as zero. */
  UNKNOWN: 'unknown',
} as const;
export type CostStatus = (typeof CostStatus)[keyof typeof CostStatus];

/** One `ai_usage_records` row before persistence. */
export interface UsageLine {
  readonly metric: PriceMetric;
  readonly quantity: number;
  /** `null` when no price is known for this metric. */
  readonly unitPrice: UsdAmount | null;
  readonly cost: UsdAmount | null;
  /** Registry price row used, when any. */
  readonly priceId: string | null;
}

export interface CostAssessment {
  readonly status: CostStatus;
  readonly reportedCost: UsdAmount | null;
  /** Sum of the lines; `null` unless every line is priced. Kept even when cost is reported. */
  readonly estimatedCost: UsdAmount | null;
  readonly lines: readonly UsageLine[];
}
