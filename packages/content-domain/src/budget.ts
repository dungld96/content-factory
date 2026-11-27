import { assessCost, UsdAmount, type PriceComponent } from '@acf/ai-core';

import { MAX_OUTPUT_TOKENS, type TextJobKind } from './jobs.js';

/**
 * Budgets (M7 design §3–§5): per-project monthly limit, optional per-content-item and per-request
 * limits, each `hard` (blocks) or `soft` (needs confirmation). Pure: no I/O.
 */

export type BudgetMode = 'hard' | 'soft';
export type BudgetScope = 'request' | 'item' | 'month';

export interface BudgetLimits {
  readonly monthlyLimit: UsdAmount;
  readonly monthlyMode: BudgetMode;
  readonly itemLimit: UsdAmount | null;
  readonly itemMode: BudgetMode;
  readonly requestLimit: UsdAmount | null;
  readonly requestMode: BudgetMode;
}

export interface BudgetUsage {
  /** Ledger costs + open and held reservations of the project in the current month. */
  readonly month: UsdAmount;
  /** The same for the content item (all time). */
  readonly item: UsdAmount;
}

/** Reserved for a call whose cost cannot be estimated (B3): unknown is never zero. */
export const UNKNOWN_COST_RESERVATION = UsdAmount.parse('0.5');
/** Share of the monthly budget at which the UI and logs warn (B8). */
export const BUDGET_WARNING_RATIO = 0.8;

export interface BudgetBreach {
  readonly scope: BudgetScope;
  readonly mode: BudgetMode;
  readonly limit: UsdAmount;
  readonly spent: UsdAmount;
  readonly requested: UsdAmount;
}

/**
 * The limit that decides the request, or null: the first hard limit it would exceed (request,
 * then item, then month), else the first soft one. A soft breach is therefore returned only when
 * no hard limit is exceeded, so accepting it can never override a hard limit. A request exactly
 * reaching a limit is allowed.
 */
export function findBudgetBreach(
  limits: BudgetLimits,
  usage: BudgetUsage,
  requested: UsdAmount,
): BudgetBreach | null {
  const breaches: BudgetBreach[] = [];
  if (limits.requestLimit && requested.compare(limits.requestLimit) > 0) {
    breaches.push({
      scope: 'request',
      mode: limits.requestMode,
      limit: limits.requestLimit,
      spent: UsdAmount.ZERO,
      requested,
    });
  }
  if (limits.itemLimit && usage.item.add(requested).compare(limits.itemLimit) > 0) {
    breaches.push({
      scope: 'item',
      mode: limits.itemMode,
      limit: limits.itemLimit,
      spent: usage.item,
      requested,
    });
  }
  if (usage.month.add(requested).compare(limits.monthlyLimit) > 0) {
    breaches.push({
      scope: 'month',
      mode: limits.monthlyMode,
      limit: limits.monthlyLimit,
      spent: usage.month,
      requested,
    });
  }
  return breaches.find((b) => b.mode === 'hard') ?? breaches[0] ?? null;
}

/** The amount reserved for one job: its estimate, or the placeholder per call when unknown. */
export function reservationAmount(
  estimate: UsdAmount | null,
  calls = 1,
): {
  readonly amount: UsdAmount;
  readonly kind: 'estimate' | 'unknown_placeholder';
} {
  return estimate === null
    ? { amount: UNKNOWN_COST_RESERVATION.times(calls), kind: 'unknown_placeholder' }
    : { amount: estimate, kind: 'estimate' };
}

/** [start, end) of the UTC calendar month containing `at` (budget period, B1). */
export function budgetMonth(at: Date): { readonly start: Date; readonly end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Worst-case usage of a text job for its reservation: the prompt allowance plus the output
 * ceiling, twice (one repair call is allowed, M3 Q5). Actual costs replace it in the ledger.
 */
export const TEXT_PROMPT_TOKEN_ALLOWANCE: Readonly<Record<TextJobKind, number>> = {
  script_generation: 6_000,
  storyboard_generation: 12_000,
};

export function textJobWorstCase(kind: TextJobKind): {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  return {
    calls: 2,
    inputTokens: TEXT_PROMPT_TOKEN_ALLOWANCE[kind],
    outputTokens: MAX_OUTPUT_TOKENS[kind],
  };
}

/**
 * Reservation estimate of a text job: its worst case priced with the model's active prices, or
 * null when a billed metric has no price (unknown, reserved with the placeholder per call).
 */
export function estimateTextJob(
  kind: TextJobKind,
  prices: readonly PriceComponent[],
): {
  readonly estimate: UsdAmount | null;
  readonly calls: number;
} {
  const worst = textJobWorstCase(kind);
  const one = assessCost({
    usage: {
      inputTokens: worst.inputTokens,
      outputTokens: worst.outputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    prices,
    reportedCost: null,
  }).estimatedCost;
  return { estimate: one === null ? null : one.times(worst.calls), calls: worst.calls };
}
