import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { paginationQuerySchema } from './pagination.js';

/**
 * Read-only AI registry contracts (M2 design package §8.2). Registry data is not
 * project-scoped and is edited only by the operator CLI. Money is a decimal string (USD),
 * never a JSON number (ADR-0012).
 */
export const aiCapabilitySchema = z
  .enum([
    'llm',
    'image_generation',
    'image_edit',
    'video_generation',
    'tts',
    'transcription',
    'vision_evaluation',
  ])
  .meta({ id: 'AiCapability' });
export const aiStatusSchema = z.enum(['enabled', 'disabled', 'degraded']).meta({ id: 'AiStatus' });
export const aiQualityTierSchema = z
  .enum(['economy', 'balanced', 'premium'])
  .meta({ id: 'AiQualityTier' });
export const aiPriceMetricSchema = z
  .enum([
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'request',
  ])
  .meta({ id: 'AiPriceMetric' });

/** Non-negative decimal USD amount as a string, e.g. "0.000000072". */
export const usdAmountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .meta({ id: 'UsdAmount', description: 'Exact decimal USD as a string (never a JSON number).' });

export const aiProviderSchema = z
  .object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    kind: z.enum(['gateway', 'direct', 'mock']),
    status: aiStatusSchema,
    /** Credentials are configured in this deployment. The credentials themselves are never exposed. */
    configured: z.boolean(),
    termsUrl: z.string().nullable(),
    dataPolicyUrl: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .meta({ id: 'AiProvider' });
export type AiProviderDto = z.infer<typeof aiProviderSchema>;

export const aiProviderListSchema = z
  .object({ data: z.array(aiProviderSchema) })
  .meta({ id: 'AiProviderList' });
export type AiProviderList = z.infer<typeof aiProviderListSchema>;

export const aiPriceSchema = z
  .object({
    id: z.uuid(),
    metric: aiPriceMetricSchema,
    /** USD per single unit (one token or one request). */
    unitPriceUsd: usdAmountSchema,
    /** The value exactly as published. */
    sourceValue: z.string(),
    currency: z.literal('USD'),
    /** Prompt-size tier: applies to calls with at least this many input tokens. */
    minPromptTokens: z.number().int(),
    effectiveFrom: isoDateTimeSchema,
    source: z.enum(['official_api', 'official_page', 'manual_estimate']),
    sourceUrl: z.string(),
    capturedAt: isoDateTimeSchema,
  })
  .meta({ id: 'AiPrice' });
export type AiPriceDto = z.infer<typeof aiPriceSchema>;

export const aiModelSchema = z
  .object({
    id: z.uuid(),
    providerKey: z.string(),
    modelKey: z.string(),
    canonicalSlug: z.string().nullable(),
    displayName: z.string(),
    capabilities: z.array(aiCapabilitySchema),
    supportedParameters: z.array(z.string()),
    inputModalities: z.array(z.string()),
    outputModalities: z.array(z.string()),
    contextLength: z.number().int().nullable(),
    maxOutputTokens: z.number().int().nullable(),
    qualityTier: aiQualityTierSchema,
    status: aiStatusSchema,
    isFreeVariant: z.boolean(),
    rateLimitNotes: z.string().nullable(),
    dataPolicyNotes: z.string().nullable(),
    benchmarkScore: z.string().nullable(),
    lastTestedAt: isoDateTimeSchema.nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
    /** Prices in force now. A metric without a row has unknown cost (never zero). */
    activePrices: z.array(aiPriceSchema),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .meta({ id: 'AiModel' });
export type AiModelDto = z.infer<typeof aiModelSchema>;

export const aiModelDetailSchema = aiModelSchema
  .extend({ priceHistory: z.array(aiPriceSchema) })
  .meta({ id: 'AiModelDetail' });
export type AiModelDetailDto = z.infer<typeof aiModelDetailSchema>;

export const aiModelIdParamsSchema = z.strictObject({ modelId: z.uuid() });

export const listAiModelsQuerySchema = paginationQuerySchema.extend({
  capability: aiCapabilitySchema.optional(),
  status: aiStatusSchema.optional(),
  qualityTier: aiQualityTierSchema.optional(),
  providerKey: z.string().min(1).max(64).optional(),
});
export type ListAiModelsQuery = z.output<typeof listAiModelsQuerySchema>;
