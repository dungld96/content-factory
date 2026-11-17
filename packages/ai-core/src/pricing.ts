import { UsdAmount } from './money.js';
import {
  CostStatus,
  PriceMetric,
  type CostAssessment,
  type LlmUsage,
  type UsageLine,
} from './usage.js';

/** One registry price row (`ai_model_prices`), already parsed. */
export interface PriceComponent {
  readonly id: string;
  readonly metric: PriceMetric;
  /** USD per single unit (one token, one request). */
  readonly unitPrice: UsdAmount;
  /** Prompt-size tier: applies when the call's input tokens are at least this many. */
  readonly minPromptTokens: number;
  readonly effectiveFrom: Date;
}

/**
 * The rows in force at `at`: for each (metric, tier) the latest row with `effectiveFrom <= at`.
 * Price history is append-only, so older rows stay and are simply superseded.
 */
export function activePrices(
  prices: readonly PriceComponent[],
  at: Date,
): readonly PriceComponent[] {
  const latest = new Map<string, PriceComponent>();
  for (const price of prices) {
    if (price.effectiveFrom.getTime() > at.getTime()) continue;
    const key = `${price.metric}\u0000${String(price.minPromptTokens)}`;
    const current = latest.get(key);
    if (!current || price.effectiveFrom.getTime() > current.effectiveFrom.getTime()) {
      latest.set(key, price);
    }
  }
  return [...latest.values()];
}

/** The price of `metric` for a call with `promptTokens` input tokens: the highest tier that applies. */
export function priceFor(
  active: readonly PriceComponent[],
  metric: PriceMetric,
  promptTokens: number,
): PriceComponent | undefined {
  let best: PriceComponent | undefined;
  for (const price of active) {
    if (price.metric !== metric || price.minPromptTokens > promptTokens) continue;
    if (!best || price.minPromptTokens > best.minPromptTokens) best = price;
  }
  return best;
}

function line(metric: PriceMetric, quantity: number, price: PriceComponent | undefined): UsageLine {
  return price
    ? {
        metric,
        quantity,
        unitPrice: price.unitPrice,
        cost: price.unitPrice.times(quantity),
        priceId: price.id,
      }
    : { metric, quantity, unitPrice: null, cost: null, priceId: null };
}

export interface AssessCostInput {
  readonly usage: LlmUsage;
  /** Price rows in force when the call started (see {@link activePrices}). */
  readonly prices: readonly PriceComponent[];
  /** Cost the provider reported for the call, if any. */
  readonly reportedCost: UsdAmount | null;
}

/**
 * Turns usage into per-metric usage lines and a cost status (ADR-0012).
 *
 * - Cached input tokens are always split out of input: providers bill them at a different rate,
 *   so without a cached price the estimate is unknown rather than a guess at the full input price.
 * - Reasoning tokens are billed as output tokens unless the model has a separate reasoning price
 *   (assumption A2), in which case they are split out.
 * - A billed metric (non-zero quantity) without a price makes the estimate unknown. Unknown cost
 *   is never zero (CLAUDE.md §2.13).
 * - A per-request fee is added only when the model has a `request` price.
 * - A reported cost always wins the status; the estimate is kept as a cross-check.
 */
export function assessCost({ usage, prices, reportedCost }: AssessCostInput): CostAssessment {
  checkUsage(usage);
  const promptTokens = usage.inputTokens;
  const find = (metric: PriceMetric) => priceFor(prices, metric, promptTokens);

  const lines: UsageLine[] = [];
  lines.push(
    line(
      PriceMetric.INPUT_TOKENS,
      usage.inputTokens - usage.cachedInputTokens,
      find(PriceMetric.INPUT_TOKENS),
    ),
  );
  if (usage.cachedInputTokens > 0) {
    lines.push(
      line(
        PriceMetric.CACHED_INPUT_TOKENS,
        usage.cachedInputTokens,
        find(PriceMetric.CACHED_INPUT_TOKENS),
      ),
    );
  }

  if (usage.cacheWriteTokens > 0) {
    lines.push(
      line(
        PriceMetric.CACHE_WRITE_TOKENS,
        usage.cacheWriteTokens,
        find(PriceMetric.CACHE_WRITE_TOKENS),
      ),
    );
  }

  const reasoningPrice = find(PriceMetric.REASONING_TOKENS);
  const splitReasoning = reasoningPrice !== undefined && usage.reasoningTokens > 0;
  const visibleOutput = splitReasoning
    ? usage.outputTokens - usage.reasoningTokens
    : usage.outputTokens;
  lines.push(line(PriceMetric.OUTPUT_TOKENS, visibleOutput, find(PriceMetric.OUTPUT_TOKENS)));
  if (splitReasoning) {
    lines.push(line(PriceMetric.REASONING_TOKENS, usage.reasoningTokens, reasoningPrice));
  }

  const requestPrice = find(PriceMetric.REQUEST);
  if (requestPrice) lines.push(line(PriceMetric.REQUEST, 1, requestPrice));

  // A zero quantity costs nothing whether or not it is priced.
  const billed = lines.filter((l) => l.quantity > 0);
  const allPriced = billed.every((l) => l.cost !== null);
  const estimatedCost = allPriced
    ? UsdAmount.sum(billed.map((l) => l.cost ?? UsdAmount.ZERO))
    : null;

  const status = reportedCost
    ? CostStatus.REPORTED
    : estimatedCost
      ? CostStatus.ESTIMATED
      : CostStatus.UNKNOWN;
  return { status, reportedCost, estimatedCost, lines };
}

function checkUsage(usage: LlmUsage): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`usage.${name} must be a non-negative integer`);
    }
  }
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new RangeError('usage.cachedInputTokens exceeds inputTokens');
  }
  if (usage.reasoningTokens > usage.outputTokens) {
    throw new RangeError('usage.reasoningTokens exceeds outputTokens');
  }
}
