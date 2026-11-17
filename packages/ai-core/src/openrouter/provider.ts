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
import { MoneyError, UsdAmount } from '../money.js';
import type { LlmUsage } from '../usage.js';
import { OPENROUTER_PROVIDER_KEY, type OpenRouterConfig } from './config.js';
import { classifyOpenRouterError, errorStatus, parseRetryAfter } from './errors.js';
import {
  openRouterCompletionSchema,
  openRouterErrorBodySchema,
  type OpenRouterCompletion,
  type OpenRouterErrorObject,
  type OpenRouterUsage,
} from './schema.js';

/**
 * Routing preferences sent with every request (decision P5, design package §7.2):
 * - `data_collection: deny`: never route to upstream providers that may train on prompts;
 * - `require_parameters: true`: only endpoints that honour every sent parameter;
 * - `allow_fallbacks: true`: OpenRouter may try another host of the SAME model.
 * The cross-model `models` fallback list is never sent.
 */
export const OPENROUTER_PROVIDER_PREFERENCES = {
  data_collection: 'deny',
  require_parameters: true,
  allow_fallbacks: true,
} as const;

/** Builds the `POST /chat/completions` body. Exported for contract tests. */
export function buildChatCompletionBody(request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelKey,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    max_tokens: request.maxOutputTokens,
    stream: false,
    provider: {
      ...OPENROUTER_PROVIDER_PREFERENCES,
      ...(request.dataPolicy?.zeroDataRetention ? { zdr: true } : {}),
    },
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

/**
 * Maps OpenRouter usage to {@link LlmUsage}. Totals are assumed to include their breakdowns
 * (assumptions A1/A2); if a breakdown exceeds its total, the assumption is wrong for this
 * response and the breakdown is added to the total instead, so no token is lost.
 */
export function normalizeOpenRouterUsage(usage: OpenRouterUsage): LlmUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const input = cached > usage.prompt_tokens ? usage.prompt_tokens + cached : usage.prompt_tokens;
  const output =
    reasoning > usage.completion_tokens
      ? usage.completion_tokens + reasoning
      : usage.completion_tokens;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
}

function reportedCostOf(usage: OpenRouterUsage | null | undefined): UsdAmount | null {
  if (usage?.cost === null || usage?.cost === undefined) return null;
  return UsdAmount.parse(usage.cost); // throws MoneyError on negative/non-finite
}

function textOf(
  content: string | readonly { type: string; text?: string | undefined }[] | null | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function finishReasonOf(reason: string | null | undefined): LlmFinishReason {
  if (reason === 'stop') return LlmFinishReason.STOP;
  if (reason === 'length') return LlmFinishReason.LENGTH;
  return LlmFinishReason.OTHER;
}

/**
 * OpenRouter adapter for {@link LlmProvider} (design package §7). Non-streaming chat completions
 * through the built-in `fetch`; no vendor SDK. Never retries and never logs: every failure is a
 * {@link ProviderError} for the caller to persist and act on.
 */
export class OpenRouterLlmProvider implements LlmProvider {
  readonly providerKey = OPENROUTER_PROVIDER_KEY;
  readonly supportedParameters: ReadonlySet<LlmParameter> = new Set(Object.values(LlmParameter));
  private readonly endpoint: string;

  constructor(private readonly config: OpenRouterConfig) {
    this.endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(
    input: LlmRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<LlmResult> {
    const request = parseLlmRequest(input);
    const remaining =
      context.deadlineAt === undefined ? Infinity : context.deadlineAt.getTime() - Date.now();
    if (signal.aborted || remaining <= 0) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'deadline passed before sending', {
        outcome: ProviderErrorOutcome.NOT_SENT,
      });
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.config.timeoutMs, remaining)));
    const combined = AbortSignal.any([signal, timeout]);

    const started = performance.now();
    let response: Response;
    let raw: string;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(buildChatCompletionBody(request)),
        signal: combined,
        redirect: 'error',
      });
      raw = await response.text();
    } catch (error) {
      // The request may have reached OpenRouter and been charged: the outcome is unknown.
      if (combined.aborted) {
        throw new ProviderError(ProviderErrorCode.TIMEOUT, 'request timed out or was aborted', {
          outcome: ProviderErrorOutcome.UNKNOWN,
          cause: error,
        });
      }
      throw new ProviderError(ProviderErrorCode.NETWORK, 'network error calling OpenRouter', {
        outcome: ProviderErrorOutcome.UNKNOWN,
        cause: error,
      });
    }
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok) throw this.rejection(response, raw);
    return this.completion(raw, latencyMs);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.config.attribution) {
      headers['HTTP-Referer'] = this.config.attribution.url;
      headers['X-OpenRouter-Title'] = this.config.attribution.title;
    }
    return headers;
  }

  /** Non-2xx: the request was rejected before generation. */
  private rejection(response: Response, raw: string): ProviderError {
    let error: OpenRouterErrorObject | undefined;
    try {
      const parsed = openRouterErrorBodySchema.safeParse(JSON.parse(raw));
      if (parsed.success) error = parsed.data.error;
    } catch {
      // Not JSON (e.g. an HTML error page): classify by status alone.
    }
    const classified = classifyOpenRouterError(response.status, error);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new ProviderError(classified.code, classified.message, {
      outcome: ProviderErrorOutcome.REJECTED,
      httpStatus: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(classified.providerErrorType === undefined
        ? {}
        : { providerErrorType: classified.providerErrorType }),
      ...(classified.providerCode === undefined ? {} : { providerCode: classified.providerCode }),
    });
  }

  /** 2xx: a completion, or a failure after acceptance (verification record §2). */
  private completion(raw: string, latencyMs: number): LlmResult {
    let body: OpenRouterCompletion;
    try {
      const parsed = openRouterCompletionSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw parsed.error;
      body = parsed.data;
    } catch (cause) {
      throw new ProviderError(
        ProviderErrorCode.MALFORMED_RESPONSE,
        'unparseable OpenRouter response',
        {
          outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
          cause,
        },
      );
    }

    let reportedCost: UsdAmount | null;
    try {
      reportedCost = reportedCostOf(body.usage);
    } catch (cause) {
      if (!(cause instanceof MoneyError)) throw cause;
      throw this.afterAcceptance(body, ProviderErrorCode.MALFORMED_RESPONSE, 'invalid usage.cost', {
        cause,
      });
    }
    const usage = body.usage ? normalizeOpenRouterUsage(body.usage) : undefined;
    const charged: Pick<ProviderErrorDetails, 'usage' | 'reportedCost'> = {
      ...(usage ? { usage } : {}),
      reportedCost,
    };

    const choice = body.choices?.[0];
    const embedded = body.error ?? choice?.error ?? undefined;
    if (embedded || choice?.finish_reason === 'error') {
      const classified = classifyOpenRouterError(
        errorStatus(embedded) ?? 502,
        embedded ?? undefined,
      );
      throw this.afterAcceptance(body, classified.code, classified.message, {
        ...charged,
        httpStatus: errorStatus(embedded) ?? 200,
        ...(classified.providerErrorType === undefined
          ? {}
          : { providerErrorType: classified.providerErrorType }),
        ...(classified.providerCode === undefined ? {} : { providerCode: classified.providerCode }),
      });
    }
    if (!choice || !body.usage || !usage) {
      throw this.afterAcceptance(
        body,
        ProviderErrorCode.MALFORMED_RESPONSE,
        !choice ? 'response has no choices' : 'response has no usage',
        charged,
      );
    }
    if (body.usage.is_byok === true) {
      // BYOK is out of scope in M2: the reported cost would not be the full cost.
      throw this.afterAcceptance(
        body,
        ProviderErrorCode.MALFORMED_RESPONSE,
        'BYOK response',
        charged,
      );
    }
    if (choice.finish_reason === 'content_filter' || (choice.message?.refusal ?? '') !== '') {
      throw this.afterAcceptance(
        body,
        ProviderErrorCode.CONTENT_POLICY,
        'content policy (content_filter)',
        charged,
      );
    }
    const text = textOf(choice.message?.content);
    if (text.length === 0) {
      throw this.afterAcceptance(body, ProviderErrorCode.EMPTY_OUTPUT, 'empty completion', charged);
    }

    return {
      text,
      finishReason: finishReasonOf(choice.finish_reason),
      providerRequestId: body.id ?? '',
      servedModel: body.model ?? '',
      usage,
      reportedCost,
      latencyMs,
    };
  }

  private afterAcceptance(
    body: OpenRouterCompletion,
    code: ProviderErrorCode,
    message: string,
    details: Omit<ProviderErrorDetails, 'outcome' | 'providerRequestId'>,
  ): ProviderError {
    return new ProviderError(code, message, {
      ...details,
      outcome: ProviderErrorOutcome.FAILED_AFTER_ACCEPTANCE,
      ...(body.id === undefined ? {} : { providerRequestId: body.id }),
    });
  }
}
