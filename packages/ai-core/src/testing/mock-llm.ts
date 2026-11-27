import type { GenerationContext } from '../capability.js';
import { ProviderError, ProviderErrorCode, ProviderErrorOutcome } from '../errors.js';
import {
  LlmFinishReason,
  LlmParameter,
  parseLlmRequest,
  requiredLlmParameters,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from '../llm.js';
import type { LlmUsage } from '../usage.js';

/** One scripted outcome. Unscripted calls get a deterministic default result. */
export type MockLlmStep =
  | {
      readonly kind: 'result';
      readonly text?: string;
      readonly finishReason?: LlmFinishReason;
      readonly usage?: Partial<LlmUsage>;
      readonly reportedCost?: LlmResult['reportedCost'];
    }
  | { readonly kind: 'error'; readonly error: ProviderError };

export interface MockLlmCall {
  readonly request: LlmRequest;
  readonly context: GenerationContext;
}

export interface MockLlmProviderOptions {
  readonly providerKey?: string;
  readonly supportedParameters?: Iterable<LlmParameter>;
  readonly steps?: readonly MockLlmStep[];
}

const ALL_PARAMETERS: readonly LlmParameter[] = Object.values(LlmParameter);

/** Rough token count used only to make mock usage deterministic and non-zero. */
const tokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * Deterministic {@link LlmProvider} for tests and local development. Makes no network calls,
 * validates requests like a real adapter, and records every call.
 */
export class MockLlmProvider implements LlmProvider {
  readonly providerKey: string;
  readonly supportedParameters: ReadonlySet<LlmParameter>;
  private readonly steps: MockLlmStep[];
  private readonly recorded: MockLlmCall[] = [];

  constructor(options: MockLlmProviderOptions = {}) {
    this.providerKey = options.providerKey ?? 'mock';
    this.supportedParameters = new Set(options.supportedParameters ?? ALL_PARAMETERS);
    this.steps = [...(options.steps ?? [])];
  }

  /** Calls received so far, in order. */
  get calls(): readonly MockLlmCall[] {
    return this.recorded;
  }

  /** Appends scripted outcomes for the next calls. */
  enqueue(...steps: MockLlmStep[]): void {
    this.steps.push(...steps);
  }

  complete(
    request: LlmRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<LlmResult> {
    try {
      return Promise.resolve(this.run(request, context, signal));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private run(input: LlmRequest, context: GenerationContext, signal: AbortSignal): LlmResult {
    const request = parseLlmRequest(input);
    if (signal.aborted) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'request aborted before sending', {
        outcome: ProviderErrorOutcome.NOT_SENT,
      });
    }
    const missing = [...requiredLlmParameters(request)].filter(
      (parameter) => !this.supportedParameters.has(parameter),
    );
    if (missing.length > 0) {
      throw new ProviderError(
        ProviderErrorCode.UNSUPPORTED_PARAMETER,
        `unsupported parameters: ${missing.sort().join(', ')}`,
        { outcome: ProviderErrorOutcome.NOT_SENT },
      );
    }
    this.recorded.push({ request, context });
    const callNumber = this.recorded.length;

    const step = this.steps.shift() ?? { kind: 'result' };
    if (step.kind === 'error') throw step.error;

    const text =
      step.text ?? (request.responseFormat?.type === 'json_schema' ? '{}' : 'mock completion');
    const inputTokens = tokens(request.messages.map((m) => m.content).join('\n'));
    const usage: LlmUsage = {
      inputTokens,
      outputTokens: Math.min(request.maxOutputTokens, tokens(text)),
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      ...step.usage,
    };
    return {
      text,
      finishReason: step.finishReason ?? LlmFinishReason.STOP,
      providerRequestId: `${this.providerKey}-${String(callNumber)}`,
      servedModel: request.modelKey,
      usage,
      reportedCost: step.reportedCost ?? null,
      latencyMs: 0,
    };
  }
}
