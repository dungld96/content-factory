import { z } from 'zod';

import type { GenerationContext } from './capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from './errors.js';
import type { UsdAmount } from './money.js';
import type { LlmUsage } from './usage.js';

/**
 * Request parameters a model must support for a call to be routed to it (AI_PROVIDER_STRATEGY §5).
 * The registry stores each model's supported set; `structured_outputs` means the model enforces a
 * JSON schema, on top of accepting `response_format`.
 */
export const LlmParameter = {
  MAX_TOKENS: 'max_tokens',
  TEMPERATURE: 'temperature',
  TOP_P: 'top_p',
  SEED: 'seed',
  STOP: 'stop',
  RESPONSE_FORMAT: 'response_format',
  STRUCTURED_OUTPUTS: 'structured_outputs',
} as const;
export type LlmParameter = (typeof LlmParameter)[keyof typeof LlmParameter];

/** Upper bounds that keep a single call's request reasonable; provider limits are checked by them. */
const MAX_MESSAGES = 256;
const MAX_MESSAGE_CHARS = 1_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;

const jsonSchemaObject = z.record(z.string(), z.unknown());

const responseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      /** Schema name, as accepted by OpenAI-compatible APIs. */
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      schema: jsonSchemaObject,
      strict: z.boolean(),
    })
    .strict(),
]);

export const llmMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(MAX_MESSAGE_CHARS),
  })
  .strict();
export type LlmMessage = z.infer<typeof llmMessageSchema>;

/** Validated before any network call; adapters receive only parsed requests. */
export const llmRequestSchema = z
  .object({
    /** Registry model key, e.g. `deepseek/deepseek-v4-flash`. */
    modelKey: z.string().min(1).max(200),
    messages: z.array(llmMessageSchema).min(1).max(MAX_MESSAGES),
    /** Required: bounds the cost of every call. */
    maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().gt(0).max(1).optional(),
    seed: z.number().int().optional(),
    stop: z.array(z.string().min(1).max(256)).min(1).max(4).optional(),
    responseFormat: responseFormatSchema.optional(),
    /** Restrict routing to zero-data-retention endpoints (decision P5: opt-in). */
    dataPolicy: z.object({ zeroDataRetention: z.boolean() }).strict().optional(),
  })
  .strict();
export type LlmRequest = z.infer<typeof llmRequestSchema>;

/**
 * Parses an untrusted request. Failures are `INVALID_REQUEST` provider errors with outcome
 * `not_sent`, so callers handle them like any other non-retryable rejection.
 */
export function parseLlmRequest(input: unknown): LlmRequest {
  const result = llmRequestSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ProviderError(
      ProviderErrorCode.INVALID_REQUEST,
      `invalid LLM request: ${fields.join(', ')}`,
      { outcome: ProviderErrorOutcome.NOT_SENT },
    );
  }
  return result.data;
}

/** The parameters a request needs its model to support. */
export function requiredLlmParameters(request: LlmRequest): ReadonlySet<LlmParameter> {
  const required = new Set<LlmParameter>([LlmParameter.MAX_TOKENS]);
  if (request.temperature !== undefined) required.add(LlmParameter.TEMPERATURE);
  if (request.topP !== undefined) required.add(LlmParameter.TOP_P);
  if (request.seed !== undefined) required.add(LlmParameter.SEED);
  if (request.stop !== undefined) required.add(LlmParameter.STOP);
  if (request.responseFormat?.type === 'json_schema') {
    required.add(LlmParameter.RESPONSE_FORMAT);
    required.add(LlmParameter.STRUCTURED_OUTPUTS);
  }
  return required;
}

/**
 * How a successful call ended. A content-filter stop is not a result: adapters raise
 * `CONTENT_POLICY` for it (design package §4.3).
 */
export const LlmFinishReason = {
  STOP: 'stop',
  /** Output token limit reached. The text is usable only if the caller accepts truncation. */
  LENGTH: 'length',
  OTHER: 'other',
} as const;
export type LlmFinishReason = (typeof LlmFinishReason)[keyof typeof LlmFinishReason];

export interface LlmResult {
  readonly text: string;
  readonly finishReason: LlmFinishReason;
  /** Provider's id for the call (e.g. OpenRouter `gen-…`), for reconciliation. */
  readonly providerRequestId: string;
  /** The model the provider reports having served. */
  readonly servedModel: string;
  readonly usage: LlmUsage;
  /** Provider-reported cost of the call; `null` when not reported. */
  readonly reportedCost: UsdAmount | null;
  readonly latencyMs: number;
}

/**
 * A text-generation provider (ADR-0004). Implementations validate input, never retry, and throw
 * only {@link ProviderError}.
 */
export interface LlmProvider {
  readonly providerKey: string;
  /** Parameters this adapter can send; intersected with the model's registry entry. */
  readonly supportedParameters: ReadonlySet<LlmParameter>;
  complete(
    request: LlmRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<LlmResult>;
}
