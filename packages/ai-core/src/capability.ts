/**
 * Media capabilities a model can declare (AI_PROVIDER_STRATEGY §2, ADR-0004). A provider registers
 * each capability explicitly; routing never assumes one implies another.
 */
export const Capability = {
  LLM: 'llm',
  IMAGE_GENERATION: 'image_generation',
  IMAGE_EDIT: 'image_edit',
  VIDEO_GENERATION: 'video_generation',
  TTS: 'tts',
  TRANSCRIPTION: 'transcription',
  VISION_EVALUATION: 'vision_evaluation',
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];

export const QualityTier = {
  ECONOMY: 'economy',
  BALANCED: 'balanced',
  PREMIUM: 'premium',
} as const;
export type QualityTier = (typeof QualityTier)[keyof typeof QualityTier];

const TIER_RANK: Readonly<Record<QualityTier, number>> = { economy: 0, balanced: 1, premium: 2 };

/** True when a model of tier `offered` meets a request for at least tier `required`. */
export function meetsQualityTier(offered: QualityTier, required: QualityTier): boolean {
  return TIER_RANK[offered] >= TIER_RANK[required];
}

/** Registry status of a provider or model (DATABASE.md §4 `ProviderStatus`). */
export const ProviderStatus = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  DEGRADED: 'degraded',
} as const;
export type ProviderStatus = (typeof ProviderStatus)[keyof typeof ProviderStatus];

/** Where a generation request comes from. Carried to the provider call and its usage records. */
export interface GenerationContext {
  readonly projectId: string;
  readonly contentItemId?: string;
  /** Set by the job layer (M5). */
  readonly generationJobId?: string;
  readonly correlationId: string;
  readonly qualityTier: QualityTier;
  readonly deadlineAt?: Date;
}
