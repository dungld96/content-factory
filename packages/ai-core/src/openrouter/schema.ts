import { z } from 'zod';

/**
 * Lenient response schemas for `POST /chat/completions` (verification record §1–§2). Unknown
 * fields are ignored and enums are read as strings, as OpenRouter's versioning policy requires:
 * new fields and enum values ship without notice.
 */
const count = z.number().int().nonnegative();
const optionalCount = count.nullish();

export const openRouterErrorObjectSchema = z.object({
  code: z.union([z.number(), z.string()]).optional(),
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type OpenRouterErrorObject = z.infer<typeof openRouterErrorObjectSchema>;

export const openRouterErrorBodySchema = z.object({ error: openRouterErrorObjectSchema });

const contentPartSchema = z.object({ type: z.string(), text: z.string().optional() });

export const openRouterUsageSchema = z.object({
  prompt_tokens: count,
  completion_tokens: count,
  total_tokens: count.optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: optionalCount, cache_write_tokens: optionalCount })
    .nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: optionalCount }).nullish(),
  cost: z.number().nullish(),
  is_byok: z.boolean().optional(),
});
export type OpenRouterUsage = z.infer<typeof openRouterUsageSchema>;

export const openRouterChoiceSchema = z.object({
  finish_reason: z.string().nullish(),
  message: z
    .object({
      content: z.union([z.string(), z.array(contentPartSchema)]).nullish(),
      refusal: z.string().nullish(),
    })
    .nullish(),
  error: openRouterErrorObjectSchema.nullish(),
});

/** A 2xx body: a completion, possibly carrying an error that occurred after acceptance. */
export const openRouterCompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(openRouterChoiceSchema).optional(),
  usage: openRouterUsageSchema.nullish(),
  error: openRouterErrorObjectSchema.nullish(),
});
export type OpenRouterCompletion = z.infer<typeof openRouterCompletionSchema>;
