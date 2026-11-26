import { z } from 'zod';

import type { GenerationContext } from '../capability.js';
import {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  type ProviderErrorDetails,
} from '../errors.js';
import {
  LlmFinishReason,
  LlmParameter,
  parseLlmRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from '../llm.js';
import type { LlmUsage } from '../usage.js';
import {
  MIXROUTE_PROVIDER_KEY,
  mixRouteEndpoint,
  mixRouteHeaders,
  type MixRouteConfig,
} from './config.js';
import { callSignal, mixRouteRejection, refuseZeroDataRetention } from './errors.js';

/**
 * OpenAI-compatible chat completion (verification record §2). Unknown fields are ignored; the
 * documented body carries no cost and no request id other than `id`.
 */
export const mixRouteCompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z
          .object({
            content: z
              .union([
                z.string(),
                z.array(z.object({ type: z.string(), text: z.string().optional() })),
              ])
              .nullable()
              .optional(),
            refusal: z.string().nullable().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().nullable().optional() })
        .nullable()
        .optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: z.number().int().nonnegative().nullable().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
export type MixRouteCompletion = z.infer<typeof mixRouteCompletionSchema>;
type MixRouteUsage = NonNullable<MixRouteCompletion['usage']>;

/** Builds the `POST /chat/completions` body. Exported for contract tests. */
export function buildMixRouteChatBody(request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelKey,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    max_tokens: request.maxOutputTokens,
    stream: false,
  };
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.topP !== undefined) body['top_p'] = request.topP;
  if (request.seed !== undefined) body['seed'] = request.seed;
  if (request.stop !== undefined) body['stop'] = request.stop;
  if (request.responseFormat?.type === 'json_schema') {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: request.responseFormat.name,
        strict: request.responseFormat.strict,
        schema: request.responseFormat.schema,
      },
    };
  }
  return body;
}

/** OpenAI usage → {@link LlmUsage}; a breakdown larger than its total is added to it. */
export function normalizeMixRouteUsage(usage: MixRouteUsage): LlmUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: cached > usage.prompt_tokens ? usage.prompt_tokens + cached : usage.prompt_tokens,
    outputTokens:
      reasoning > usage.completion_tokens
        ? usage.completion_tokens + reasoning
        : usage.completion_tokens,
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: reasoning,
  };
}

function textOf(content: NonNullable<MixRouteCompletion['choices']>[number]['message']): string {
  const value = content?.content;
  if (typeof value === 'string') return value;
  if (!value) return '';
  return value
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function finishReasonOf(reason: string | null | undefined): LlmFinishReason {
  if (reason === 'stop') return LlmFinishReason.STOP;
  if (reason === 'length') return LlmFinishReason.LENGTH;
  return LlmFinishReason.OTHER;
}

/**
 * MixRoute adapter for {@link LlmProvider} (P5). Non-streaming chat completions through the
 * built-in `fetch`. MixRoute reports no per-call cost: `reportedCost` is always `null`, so the
 * ledger records the registry estimate (P5 decision G3). Never retries and never logs.
 */
export class MixRouteLlmProvider implements LlmProvider {
  readonly providerKey = MIXROUTE_PROVIDER_KEY;
  readonly supportedParameters: ReadonlySet<LlmParameter> = new Set(Object.values(LlmParameter));
  private readonly endpoint: string;

  constructor(private readonly config: MixRouteConfig) {
    this.endpoint = mixRouteEndpoint(config, '/chat/completions');
  }

  async complete(
    input: LlmRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<LlmResult> {
    const request = parseLlmRequest(input);
    if (request.dataPolicy?.zeroDataRetention) throw refuseZeroDataRetention();
    const combined = callSignal(signal, context.deadlineAt, this.config.timeoutMs);

    const started = performance.now();
    let response: Response;
    let raw: string;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: mixRouteHeaders(this.config),
        body: JSON.stringify(buildMixRouteChatBody(request)),
        signal: combined,
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      // The request may have reached MixRoute and been charged: the outcome is unknown.
      throw new ProviderError(
        combined.aborted ? ProviderErrorCode.TIMEOUT : ProviderErrorCode.NETWORK,
        combined.aborted ? 'request timed out or was aborted' : 'network error calling MixRoute',
        { outcome: ProviderErrorOutcome.UNKNOWN, cause: error },
      );
    }
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) throw mixRouteRejection(response, raw);
    return this.completion(raw, latencyMs, response.headers.get('x-request-id'));
  }

  private completion(raw: string, latencyMs: number, headerId: string | null): LlmResult {
    let body: MixRouteCompletion;
    try {
      const parsed = mixRouteCompletionSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw parsed.error;
      body = parsed.data;
    } catch (cause) {
      throw new ProviderError(
        ProviderErrorCode.MALFORMED_RESPONSE,
        'unparseable MixRoute response',
        {
          outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
          cause,
        },
      );
    }
    const requestId = body.id ?? headerId ?? undefined;
    const usage = body.usage ? normalizeMixRouteUsage(body.usage) : undefined;
    const fail = (code: ProviderErrorCode, message: string): ProviderError => {
      const details: ProviderErrorDetails = {
        outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
        reportedCost: null,
        ...(usage ? { usage } : {}),
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
      };
      return new ProviderError(code, message, details);
    };

    const choice = body.choices?.[0];
    if (!choice) throw fail(ProviderErrorCode.MALFORMED_RESPONSE, 'response has no choices');
    if (!usage) throw fail(ProviderErrorCode.MALFORMED_RESPONSE, 'response has no usage');
    if (choice.finish_reason === 'content_filter' || (choice.message?.refusal ?? '') !== '') {
      throw fail(ProviderErrorCode.CONTENT_POLICY, 'content policy (content_filter)');
    }
    const text = textOf(choice.message);
    if (text.length === 0) throw fail(ProviderErrorCode.EMPTY_OUTPUT, 'empty completion');

    return {
      text,
      finishReason: finishReasonOf(choice.finish_reason),
      providerRequestId: requestId ?? '',
      servedModel: body.model ?? '',
      usage,
      reportedCost: null,
      latencyMs,
    };
  }
}
