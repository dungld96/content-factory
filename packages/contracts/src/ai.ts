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
    // Image generation (M4)
    'output_images',
    'input_images',
    'output_pixels',
    'input_pixels',
    'output_image_tokens',
    'input_image_tokens',
    'output_video_seconds',
    'output_video_tokens',
    'input_characters',
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
    /** Resolution/audio tier the price applies to (e.g. `720p-silent`); '' = any request. */
    variant: z.string(),
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
    /** Structured-output mode for LLMs (`full` | `basic`, M8.5). */
    schemaMode: z.enum(['full', 'basic']),
    isFreeVariant: z.boolean(),
    rateLimitNotes: z.string().nullable(),
    dataPolicyNotes: z.string().nullable(),
    benchmarkScore: z.string().nullable(),
    lastTestedAt: isoDateTimeSchema.nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
    /** Prices in force now. A metric without a row has unknown cost (never zero). */
    activePrices: z.array(aiPriceSchema),
    /** Provider voice ids of a text-to-speech model (M8.5 Q5); null when not a TTS model or unlisted. */
    voices: z.array(z.string()).nullable(),
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

// ------------------------------------------------------------------- P1: operator settings

/** Generation tasks with a routed model (`ai_task_routes.task`). */
export const aiTaskSchema = z
  .enum([
    'script_generation',
    'storyboard_generation',
    'image_generation',
    'video_generation',
    'tts_generation',
  ])
  .meta({ id: 'AiTask' });
export type AiTask = z.infer<typeof aiTaskSchema>;
export const aiTaskParamsSchema = z.strictObject({ task: aiTaskSchema });
export const aiProviderKeyParamsSchema = z.strictObject({
  providerKey: z.string().min(1).max(64),
});

/** `GET /ai/routes`: every task and the model it is routed to (P1 O4). */
export const aiRouteSchema = z
  .object({
    task: aiTaskSchema,
    model: z
      .object({
        id: z.uuid(),
        modelKey: z.string(),
        displayName: z.string(),
        status: aiStatusSchema,
      })
      .nullable(),
    provider: z
      .object({ key: z.string(), status: aiStatusSchema, configured: z.boolean() })
      .nullable(),
    zeroDataRetention: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'AiRoute' });
export type AiRouteDto = z.infer<typeof aiRouteSchema>;
export const aiRouteListSchema = z
  .object({ data: z.array(aiRouteSchema) })
  .meta({ id: 'AiRouteList' });
export type AiRouteList = z.infer<typeof aiRouteListSchema>;

/** `PUT /ai/routes/:task` (operator). */
export const setAiRouteRequestSchema = z
  .strictObject({
    modelKey: z.string().min(1).max(200),
    providerKey: z.string().min(1).max(64).optional(),
    zeroDataRetention: z.boolean().optional(),
  })
  .meta({ id: 'SetAiRouteRequest' });
export type SetAiRouteRequest = z.output<typeof setAiRouteRequestSchema>;

/** `PATCH /ai/providers/:providerKey` (operator). */
export const updateAiProviderRequestSchema = z
  .strictObject({ status: aiStatusSchema })
  .meta({ id: 'UpdateAiProviderRequest' });
export type UpdateAiProviderRequest = z.output<typeof updateAiProviderRequestSchema>;

/** `PATCH /ai/models/:modelId` (operator). */
export const updateAiModelRequestSchema = z
  .strictObject({
    status: aiStatusSchema.optional(),
    schemaMode: z.enum(['full', 'basic']).optional(),
  })
  .refine((v) => v.status !== undefined || v.schemaMode !== undefined, {
    message: 'at least one field is required',
  })
  .meta({ id: 'UpdateAiModelRequest' });
export type UpdateAiModelRequest = z.output<typeof updateAiModelRequestSchema>;

/** `GET /ai/registry-events` (operator): the registry audit, newest first (P1 O6). */
export const aiRegistryEventSchema = z
  .object({
    id: z.uuid(),
    source: z.enum(['api', 'cli']),
    actor: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }).nullable(),
    action: z.string(),
    target: z.string(),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'AiRegistryEvent' });
export type AiRegistryEventDto = z.infer<typeof aiRegistryEventSchema>;

/** `POST /ai/providers/:providerKey/test` (operator): a free credential check (P1 O3). */
export const aiProviderKeyCheckSchema = z
  .object({
    providerKey: z.string(),
    result: z.enum(['valid', 'rejected', 'unreachable', 'not_configured']),
    httpStatus: z.number().int().nullable(),
    /** As the provider reports them; null when not reported. */
    limitRemaining: z.number().nullable(),
    usage: z.number().nullable(),
    isFreeTier: z.boolean().nullable(),
    checkedAt: z.string(),
  })
  .meta({ id: 'AiProviderKeyCheck' });
export type AiProviderKeyCheckDto = z.infer<typeof aiProviderKeyCheckSchema>;
