import {
  activePrices,
  assessCost,
  Capability,
  filterCandidates,
  isProviderError,
  parseLlmRequest,
  ProviderErrorOutcome,
  requiredLlmParameters,
  sanitizeProviderMessage,
  type CostAssessment,
  type GenerationContext,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
  type RoutingDecision,
} from '@acf/ai-core';
import { type Prisma, type AiInvocationStatus, type PrismaClient } from '@acf/database';

import { type ModelCatalog, type CandidateRow } from './model-catalog.js';

/** No eligible model for a request. Nothing was sent and no invocation was recorded. */
export class RoutingError extends Error {
  override readonly name = 'RoutingError';
  constructor(
    readonly modelKey: string,
    readonly decision: RoutingDecision,
  ) {
    super(
      `no eligible model for ${modelKey}: ${decision.explanation.join('; ') || 'not registered'}`,
    );
  }
}

export interface LlmCallOptions {
  /** Restrict to one provider when several register the same model key. */
  readonly providerKey?: string;
  readonly signal?: AbortSignal;
  /** Set by the job layer; unique per call (`{jobId}:{attempt}:{call}`, M3). */
  readonly idempotencyKey?: string;
  /**
   * Operator smoke test only (`pnpm ai:registry smoke`): route to a disabled model/provider so
   * it can be tried before it is enabled. Credentials and parameters are still required.
   */
  readonly allowDisabled?: boolean;
}

/** Error code recorded for invocations whose process stopped before recording an outcome. */
export const ABANDONED_ERROR_CODE = 'ABANDONED';
/** Grace added to the provider timeout before a `started` invocation counts as abandoned. */
const ABANDON_GRACE_MS = 60_000;

/**
 * The only entry point business code uses to call an LLM (design package §7.4):
 * route → persist intent → call through the `LlmProvider` interface → persist outcome and usage.
 * Adapters never retry and neither does this service (decision P4); callers (M3/M5 jobs) act on
 * `ProviderError.retryable` / `fallbackAllowed`.
 */
export interface LlmServiceOptions {
  /** The longest provider timeout in use; with a grace period it defines an abandoned call. */
  readonly providerTimeoutMs: number;
}

export class LlmService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: ModelCatalog,
    private readonly providers: ReadonlyMap<string, LlmProvider>,
    private readonly options: LlmServiceOptions,
  ) {}

  async complete(
    context: GenerationContext,
    input: LlmRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmResult> {
    const request = parseLlmRequest(input);
    const { row, decision } = await this.route(context, request, options);
    const provider = this.providers.get(row.candidate.providerKey);
    if (!provider) throw new RoutingError(request.modelKey, decision); // unreachable: filtered

    const invocation = await this.prisma.aiInvocation.create({
      data: {
        projectId: context.projectId,
        contentItemId: context.contentItemId ?? null,
        generationJobId: context.generationJobId ?? null,
        correlationId: context.correlationId,
        idempotencyKey: options.idempotencyKey ?? null,
        capability: Capability.LLM,
        providerId: row.providerId,
        modelId: row.candidate.modelId,
        requestSummary: requestSummary(request, decision),
      },
      select: { id: true, startedAt: true },
    });
    const prices = activePrices(row.prices, invocation.startedAt);

    let result: LlmResult;
    try {
      result = await provider.complete(
        request,
        context,
        options.signal ?? new AbortController().signal,
      );
    } catch (error) {
      await this.recordFailure(invocation.id, error, prices);
      throw error;
    }
    const cost = assessCost({ usage: result.usage, prices, reportedCost: result.reportedCost });
    await this.recordOutcome(invocation.id, 'succeeded', cost, {
      servedModel: result.servedModel || null,
      providerRequestId: result.providerRequestId || null,
      finishReason: result.finishReason,
      latencyMs: result.latencyMs,
    });
    return result;
  }

  /**
   * Marks invocations still `started` long after any call could have finished (the process
   * stopped mid-call) as `outcome_unknown`. They may have been charged, so they are never re-sent
   * automatically (risk R4). Safe with several instances: only rows past every deadline match.
   * Run explicitly (`pnpm ai:registry invocations mark-abandoned`; the M5 worker at start-up),
   * never as a hidden side effect of API start-up, which must not depend on the database.
   */
  async markAbandoned(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.options.providerTimeoutMs - ABANDON_GRACE_MS);
    const { count } = await this.prisma.aiInvocation.updateMany({
      where: { status: 'started', startedAt: { lt: cutoff } },
      data: {
        status: 'outcome_unknown',
        completedAt: now,
        errorCode: ABANDONED_ERROR_CODE,
        errorMessage: 'the process stopped before recording the outcome',
      },
    });
    return count;
  }

  private async route(
    context: GenerationContext,
    request: LlmRequest,
    options: LlmCallOptions,
  ): Promise<{ row: CandidateRow; decision: RoutingDecision }> {
    const rows = (await this.catalog.candidates(Capability.LLM, request.modelKey)).filter(
      (r) => options.providerKey === undefined || r.candidate.providerKey === options.providerKey,
    );
    const decision = filterCandidates(
      rows.map((r) =>
        options.allowDisabled
          ? { ...r.candidate, modelStatus: 'enabled' as const, providerStatus: 'enabled' as const }
          : r.candidate,
      ),
      {
        capability: Capability.LLM,
        parameters: requiredLlmParameters(request),
        minimumTier: context.qualityTier,
        modelKey: request.modelKey,
      },
    );
    const chosen = decision.eligible[0];
    const row = chosen && rows.find((r) => r.candidate.modelId === chosen.modelId);
    if (!row) throw new RoutingError(request.modelKey, decision);
    return { row, decision };
  }

  private async recordFailure(
    invocationId: string,
    error: unknown,
    prices: Parameters<typeof assessCost>[0]['prices'],
  ): Promise<void> {
    if (!isProviderError(error)) {
      await this.recordOutcome(invocationId, 'failed', null, {
        errorCode: 'INTERNAL_ERROR',
        errorMessage: sanitizeProviderMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return;
    }
    // A failure after acceptance may still be charged: its usage is recorded like a success's.
    const cost = error.usage
      ? assessCost({ usage: error.usage, prices, reportedCost: error.reportedCost })
      : null;
    await this.recordOutcome(
      invocationId,
      error.outcome === ProviderErrorOutcome.UNKNOWN ? 'outcome_unknown' : 'failed',
      cost,
      {
        errorCode: error.code,
        errorMessage: error.message,
        providerRequestId: error.providerRequestId ?? null,
      },
    );
  }

  private async recordOutcome(
    invocationId: string,
    status: Exclude<AiInvocationStatus, 'started'>,
    cost: CostAssessment | null,
    fields: Partial<{
      servedModel: string | null;
      providerRequestId: string | null;
      finishReason: string;
      latencyMs: number;
      errorCode: string;
      errorMessage: string;
    }>,
  ): Promise<void> {
    const costFields = cost
      ? {
          costStatus: cost.status,
          reportedCost: cost.reportedCost?.toString() ?? null,
          estimatedCost: cost.estimatedCost?.toString() ?? null,
        }
      : { costStatus: 'unknown' as const, reportedCost: null, estimatedCost: null };
    await this.prisma.$transaction(async (tx) => {
      // Guarded: the row gets exactly one outcome (the AC011 trigger enforces it too).
      const { count } = await tx.aiInvocation.updateMany({
        where: { id: invocationId, status: 'started' },
        data: { status, completedAt: new Date(), ...costFields, ...fields },
      });
      if (count !== 1) throw new Error(`invocation ${invocationId} already has an outcome`);
      if (cost && cost.lines.length > 0) {
        const projectId = (
          await tx.aiInvocation.findUniqueOrThrow({
            where: { id: invocationId },
            select: { projectId: true },
          })
        ).projectId;
        await tx.aiUsageRecord.createMany({
          data: cost.lines.map((line) => ({
            invocationId,
            projectId,
            metric: line.metric,
            quantity: BigInt(line.quantity),
            unitPrice: line.unitPrice?.toString() ?? null,
            cost: line.cost?.toString() ?? null,
            priceId: line.priceId,
            source: 'provider_reported' as const,
          })),
        });
      }
    });
  }
}

/** Parameters and routing only. Never messages, schemas' content values or credentials. */
function requestSummary(request: LlmRequest, decision: RoutingDecision): Prisma.InputJsonObject {
  return {
    modelKey: request.modelKey,
    messageCount: request.messages.length,
    maxOutputTokens: request.maxOutputTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.stop === undefined ? {} : { stopCount: request.stop.length }),
    ...(request.responseFormat === undefined
      ? {}
      : {
          responseFormat:
            request.responseFormat.type === 'json_schema'
              ? {
                  type: 'json_schema',
                  name: request.responseFormat.name,
                  strict: request.responseFormat.strict,
                }
              : { type: 'text' },
        }),
    zeroDataRetention: request.dataPolicy?.zeroDataRetention ?? false,
    routing: [...decision.explanation],
  };
}
