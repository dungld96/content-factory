import type { ImageResolution, ImageUsage } from './media.js';
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
  /**
   * Output tier the price applies to (image resolution, e.g. `2k`); `''` = any request (M4).
   * A tier-specific price wins over the general one.
   */
  readonly variant: string;
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
    const key = `${price.metric}\u0000${String(price.minPromptTokens)}\u0000${price.variant}`;
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
    if (price.variant !== '') continue; // tiered (image) prices: see imagePriceFor
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

// ----------------------------------------------------------------------------- images (M4)

/** Registry variant name of a resolution tier (catalog `variant`, e.g. `2k`, `1.5k`, `768`). */
export const resolutionVariant = (resolution: ImageResolution | undefined): string =>
  resolution === undefined ? '' : resolution.toLowerCase();

/** The image price for `metric`: the tier-specific one when it exists, else the general one. */
export function imagePriceFor(
  active: readonly PriceComponent[],
  metric: PriceMetric,
  variant: string,
): PriceComponent | undefined {
  const of = (v: string) => active.find((p) => p.metric === metric && p.variant === v);
  return (variant === '' ? undefined : of(variant)) ?? of('');
}

export interface AssessImageCostInput {
  readonly usage: ImageUsage;
  readonly prices: readonly PriceComponent[];
  readonly reportedCost: UsdAmount | null;
  /** The requested resolution tier (`resolutionVariant`). */
  readonly variant: string;
}

const IMAGE_METRICS: readonly (readonly [PriceMetric, keyof ImageUsage])[] = [
  [PriceMetric.OUTPUT_IMAGES, 'outputImages'],
  [PriceMetric.INPUT_IMAGES, 'inputImages'],
  [PriceMetric.OUTPUT_PIXELS, 'outputPixels'],
  [PriceMetric.INPUT_PIXELS, 'inputPixels'],
  [PriceMetric.OUTPUT_IMAGE_TOKENS, 'outputTokens'],
  [PriceMetric.INPUT_IMAGE_TOKENS, 'inputTokens'],
];

/**
 * Usage lines and cost status of one image call (ADR-0012 rules, M4 design §6). Only metrics the
 * model is priced on are billed: a model priced per image is not also billed per pixel. A priced
 * metric whose quantity was not reported (e.g. tokens) makes the estimate unknown — never zero.
 */
export function assessImageCost({
  usage,
  prices,
  reportedCost,
  variant,
}: AssessImageCostInput): CostAssessment {
  const quantities: Readonly<Record<string, number | null>> = {
    output_images: usage.outputImages,
    input_images: usage.inputImages,
    output_pixels: usage.outputPixels,
    input_pixels: usage.inputPixels,
    output_image_tokens: usage.outputTokens,
    input_image_tokens: usage.inputTokens,
  };
  const lines: UsageLine[] = [];
  let unknown = false;
  for (const [metric] of IMAGE_METRICS) {
    const price = imagePriceFor(prices, metric, variant);
    if (!price) continue;
    const quantity = quantities[metric] ?? null;
    if (quantity === null) {
      unknown = true;
      continue;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new RangeError(`image usage ${metric} must be a non-negative integer`);
    }
    lines.push(line(metric, quantity, price));
  }
  if (lines.length === 0 && usage.outputImages > 0) unknown = true; // no image price at all
  const requestPrice = imagePriceFor(prices, PriceMetric.REQUEST, variant);
  if (requestPrice) lines.push(line(PriceMetric.REQUEST, 1, requestPrice));
  const estimatedCost = unknown ? null : UsdAmount.sum(lines.map((l) => l.cost ?? UsdAmount.ZERO));
  const status = reportedCost
    ? CostStatus.REPORTED
    : estimatedCost
      ? CostStatus.ESTIMATED
      : CostStatus.UNKNOWN;
  return { status, reportedCost, estimatedCost, lines };
}

/** Approximate output size of a tier at an aspect ratio (long side = tier), for estimates only. */
export function approximatePixels(
  resolution: ImageResolution | undefined,
  aspectRatio: string,
): number {
  const long = { '512': 512, '768': 768, '1K': 1024, '1.5K': 1536, '2K': 2048, '4K': 4096 }[
    resolution ?? '1K'
  ];
  const [a, b] = aspectRatio.split(':').map(Number);
  const ratio = a && b ? Math.min(a, b) / Math.max(a, b) : 1;
  return Math.round(long * Math.round(long * ratio));
}

/**
 * Pre-generation estimate for `count` images (M4 design §6): `null` when the model is priced by
 * token (unknowable before the call) or not priced. Never zero for an unpriced model.
 */
export function estimateImageCost(input: {
  readonly prices: readonly PriceComponent[];
  readonly count: number;
  readonly references: number;
  readonly resolution: ImageResolution | undefined;
  readonly aspectRatio: string;
}): UsdAmount | null {
  const pixels = approximatePixels(input.resolution, input.aspectRatio);
  const assessed = assessImageCost({
    usage: {
      outputImages: input.count,
      inputImages: input.references,
      outputPixels: pixels * input.count,
      inputPixels: null,
      outputTokens: null,
      inputTokens: null,
    },
    prices: input.prices,
    reportedCost: null,
    variant: resolutionVariant(input.resolution),
  });
  return assessed.estimatedCost;
}
