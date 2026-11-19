import {
  isProviderError,
  ProviderErrorOutcome,
  sanitizeProviderMessage,
  type CostAssessment,
} from '@acf/ai-core';
import type { AiInvocationStatus, PrismaClient } from '@acf/database';

/** Outcome fields of an invocation (M2 ledger, ADR-0012). */
export interface OutcomeFields {
  readonly servedModel?: string | null;
  readonly providerRequestId?: string | null;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Writes an invocation's final status, cost and usage lines in one transaction. Only a
 * `started` invocation can get an outcome (exactly once).
 */
export async function recordInvocationOutcome(
  prisma: PrismaClient,
  invocationId: string,
  status: Exclude<AiInvocationStatus, 'started'>,
  cost: CostAssessment | null,
  fields: OutcomeFields,
): Promise<void> {
  const costFields = cost
    ? {
        costStatus: cost.status,
        reportedCost: cost.reportedCost?.toString() ?? null,
        estimatedCost: cost.estimatedCost?.toString() ?? null,
      }
    : { costStatus: 'unknown' as const, reportedCost: null, estimatedCost: null };
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.aiInvocation.updateMany({
      where: { id: invocationId, status: 'started' },
      data: { status, completedAt: new Date(), ...costFields, ...fields },
    });
    if (count !== 1) throw new Error(`invocation ${invocationId} already has an outcome`);
    if (cost && cost.lines.length > 0) {
      const { projectId } = await tx.aiInvocation.findUniqueOrThrow({
        where: { id: invocationId },
        select: { projectId: true },
      });
      await tx.aiUsageRecord.createMany({
        data: cost.lines.map((line) => ({
          invocationId,
          projectId,
          metric: line.metric,
          quantity: BigInt(line.quantity),
          unitPrice: line.unitPrice?.toString() ?? null,
          cost: line.cost?.toString() ?? null,
          priceId: line.priceId,
          source: 'calculated' as const,
        })),
      });
    }
  });
}

/**
 * Records a failed call. A provider error whose outcome is `unknown` (the request may have been
 * processed and charged) becomes `outcome_unknown`; its cost is `unknown`, never zero.
 */
export async function recordInvocationFailure(
  prisma: PrismaClient,
  invocationId: string,
  error: unknown,
): Promise<void> {
  if (!isProviderError(error)) {
    await recordInvocationOutcome(prisma, invocationId, 'failed', null, {
      errorCode: 'INTERNAL_ERROR',
      errorMessage: sanitizeProviderMessage(error instanceof Error ? error.message : String(error)),
    });
    return;
  }
  const cost: CostAssessment | null = error.reportedCost
    ? { status: 'reported', reportedCost: error.reportedCost, estimatedCost: null, lines: [] }
    : null;
  await recordInvocationOutcome(
    prisma,
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
