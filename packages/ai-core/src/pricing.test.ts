import { describe, expect, it } from 'vitest';

import { UsdAmount } from './money.js';
import type { ImageUsage } from './media.js';
import {
  activePrices,
  approximatePixels,
  assessCost,
  assessImageCost,
  estimateImageCost,
  priceFor,
  type PriceComponent,
} from './pricing.js';
import { CostStatus, PriceMetric, type LlmUsage, type PriceMetric as Metric } from './usage.js';

const day = (n: number) => new Date(Date.UTC(2026, 10, n));
let seq = 0;
const price = (
  metric: Metric,
  usd: string,
  options: { minPromptTokens?: number; from?: Date; id?: string; variant?: string } = {},
): PriceComponent => ({
  id: options.id ?? `p${String(++seq)}`,
  metric,
  unitPrice: UsdAmount.parse(usd),
  minPromptTokens: options.minPromptTokens ?? 0,
  variant: options.variant ?? '',
  effectiveFrom: options.from ?? day(1),
});
const usage = (u: Partial<LlmUsage>): LlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...u,
});

// deepseek/deepseek-v4-flash, catalog 2026-11-17: USD 0.072 / 0.144 per million tokens.
const flash = [
  price(PriceMetric.INPUT_TOKENS, '0.000000072'),
  price(PriceMetric.OUTPUT_TOKENS, '0.000000144'),
];

describe('activePrices', () => {
  it('picks the latest row per metric and tier that is in force', () => {
    const old = price(PriceMetric.INPUT_TOKENS, '0.1', { from: day(1), id: 'old' });
    const current = price(PriceMetric.INPUT_TOKENS, '0.2', { from: day(10), id: 'current' });
    const future = price(PriceMetric.INPUT_TOKENS, '0.3', { from: day(20), id: 'future' });
    const tier = price(PriceMetric.INPUT_TOKENS, '0.4', { minPromptTokens: 100_000, id: 'tier' });
    const ids = activePrices([old, current, future, tier], day(15)).map((p) => p.id);
    expect(ids.sort()).toEqual(['current', 'tier']);
    expect(activePrices([old, current], day(1)).map((p) => p.id)).toEqual(['old']);
    expect(activePrices([current], day(1))).toEqual([]);
  });
});

describe('priceFor', () => {
  it('uses the highest prompt-size tier that applies', () => {
    const base = price(PriceMetric.INPUT_TOKENS, '0.0000001', { id: 'base' });
    const large = price(PriceMetric.INPUT_TOKENS, '0.0000005', {
      minPromptTokens: 100_000,
      id: 'large',
    });
    expect(priceFor([base, large], PriceMetric.INPUT_TOKENS, 99_999)?.id).toBe('base');
    expect(priceFor([base, large], PriceMetric.INPUT_TOKENS, 100_000)?.id).toBe('large');
    expect(priceFor([large], PriceMetric.INPUT_TOKENS, 10)).toBeUndefined();
  });
});

describe('assessCost', () => {
  it('estimates exactly when every billed metric is priced', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 1000, outputTokens: 500 }),
      prices: flash,
      reportedCost: null,
    });
    expect(result.status).toBe(CostStatus.ESTIMATED);
    // 1000 × 0.072e-6 + 500 × 0.144e-6 = 0.000144
    expect(result.estimatedCost?.toString()).toBe('0.000144');
    expect(result.lines.map((l) => [l.metric, l.quantity, l.cost?.toString()])).toEqual([
      ['input_tokens', 1000, '0.000072'],
      ['output_tokens', 500, '0.000072'],
    ]);
  });

  it('prefers the reported cost but keeps the estimate', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 1000, outputTokens: 500 }),
      prices: flash,
      reportedCost: UsdAmount.parse('0.00015'),
    });
    expect(result.status).toBe(CostStatus.REPORTED);
    expect(result.reportedCost?.toString()).toBe('0.00015');
    expect(result.estimatedCost?.toString()).toBe('0.000144');
  });

  it('is unknown, never zero, when a billed metric has no price', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 1000, outputTokens: 500 }),
      prices: [price(PriceMetric.INPUT_TOKENS, '0.000000072')],
      reportedCost: null,
    });
    expect(result.status).toBe(CostStatus.UNKNOWN);
    expect(result.estimatedCost).toBeNull();
    expect(result.lines.find((l) => l.metric === 'output_tokens')?.cost).toBeNull();
  });

  it('is unknown with no prices at all', () => {
    const result = assessCost({ usage: usage({ inputTokens: 1 }), prices: [], reportedCost: null });
    expect(result.status).toBe(CostStatus.UNKNOWN);
  });

  it('treats an explicit zero price as a real zero (free variant)', () => {
    const free = [price(PriceMetric.INPUT_TOKENS, '0'), price(PriceMetric.OUTPUT_TOKENS, '0')];
    const result = assessCost({
      usage: usage({ inputTokens: 10, outputTokens: 10 }),
      prices: free,
      reportedCost: null,
    });
    expect(result.status).toBe(CostStatus.ESTIMATED);
    expect(result.estimatedCost?.isZero()).toBe(true);
  });

  it('a zero quantity needs no price', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 100, outputTokens: 0 }),
      prices: [price(PriceMetric.INPUT_TOKENS, '0.000001')],
      reportedCost: null,
    });
    expect(result.status).toBe(CostStatus.ESTIMATED);
    expect(result.estimatedCost?.toString()).toBe('0.0001');
  });

  it('splits cached input tokens out of input and prices them separately', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 }),
      prices: [...flash, price(PriceMetric.CACHED_INPUT_TOKENS, '0.0000000144')],
      reportedCost: null,
    });
    expect(result.lines.map((l) => [l.metric, l.quantity])).toEqual([
      ['input_tokens', 600],
      ['cached_input_tokens', 400],
      ['output_tokens', 100],
    ]);
    // 600×0.072e-6 + 400×0.0144e-6 + 100×0.144e-6
    expect(result.estimatedCost?.toString()).toBe('0.00006336');
  });

  it('is unknown when cached tokens have no cached price (no guess at the input price)', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 }),
      prices: flash,
      reportedCost: null,
    });
    expect(result.status).toBe(CostStatus.UNKNOWN);
  });

  it('bills reasoning tokens as output unless a reasoning price exists', () => {
    const asOutput = assessCost({
      usage: usage({ inputTokens: 10, outputTokens: 100, reasoningTokens: 80 }),
      prices: flash,
      reportedCost: null,
    });
    expect(asOutput.lines.map((l) => [l.metric, l.quantity])).toEqual([
      ['input_tokens', 10],
      ['output_tokens', 100],
    ]);
    const split = assessCost({
      usage: usage({ inputTokens: 10, outputTokens: 100, reasoningTokens: 80 }),
      prices: [...flash, price(PriceMetric.REASONING_TOKENS, '0.000001')],
      reportedCost: null,
    });
    expect(split.lines.map((l) => [l.metric, l.quantity])).toEqual([
      ['input_tokens', 10],
      ['output_tokens', 20],
      ['reasoning_tokens', 80],
    ]);
  });

  it('adds cache writes and a per-request fee when present', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 10, outputTokens: 10, cacheWriteTokens: 5 }),
      prices: [
        ...flash,
        price(PriceMetric.CACHE_WRITE_TOKENS, '0.000001'),
        price(PriceMetric.REQUEST, '0.01'),
      ],
      reportedCost: null,
    });
    expect(result.lines.map((l) => l.metric)).toEqual([
      'input_tokens',
      'cache_write_tokens',
      'output_tokens',
      'request',
    ]);
    expect(result.estimatedCost?.toString()).toBe('0.01000716');
  });

  it('is unknown when cache writes are not priced', () => {
    const result = assessCost({
      usage: usage({ inputTokens: 10, outputTokens: 10, cacheWriteTokens: 5 }),
      prices: flash,
      reportedCost: null,
    });
    expect(result.status).toBe(CostStatus.UNKNOWN);
  });

  it('applies the prompt-size tier to every metric', () => {
    const tiered = [
      price(PriceMetric.INPUT_TOKENS, '0.0000001'),
      price(PriceMetric.OUTPUT_TOKENS, '0.0000005'),
      price(PriceMetric.INPUT_TOKENS, '0.0000005', { minPromptTokens: 100_000 }),
      price(PriceMetric.OUTPUT_TOKENS, '0.0000025', { minPromptTokens: 100_000 }),
    ];
    const result = assessCost({
      usage: usage({ inputTokens: 100_000, outputTokens: 1000 }),
      prices: tiered,
      reportedCost: null,
    });
    expect(result.estimatedCost?.toString()).toBe('0.0525');
  });

  it.each([
    usage({ inputTokens: -1 }),
    usage({ inputTokens: 1.5 }),
    usage({ inputTokens: 10, cachedInputTokens: 11 }),
    usage({ outputTokens: 10, reasoningTokens: 11 }),
  ])('rejects inconsistent usage %o', (bad) => {
    expect(() => assessCost({ usage: bad, prices: flash, reportedCost: null })).toThrow(RangeError);
  });
});

describe('image pricing (M4)', () => {
  const imageUsage = (u: Partial<ImageUsage>): ImageUsage => ({
    outputImages: 1,
    inputImages: 0,
    outputPixels: null,
    inputPixels: null,
    outputTokens: null,
    inputTokens: null,
    ...u,
  });

  it('prices per image, preferring the resolution tier', () => {
    const prices = [
      price('output_images', '0.009'),
      price('output_images', '0.014', { variant: '2k' }),
    ];
    const at2k = assessImageCost({
      usage: imageUsage({ outputImages: 2 }),
      prices,
      reportedCost: null,
      variant: '2k',
    });
    expect(at2k.status).toBe('estimated');
    expect(at2k.estimatedCost?.toString()).toBe('0.028');
    const general = assessImageCost({
      usage: imageUsage({}),
      prices,
      reportedCost: null,
      variant: '1k',
    });
    expect(general.estimatedCost?.toString()).toBe('0.009');
  });

  it('bills only metrics the model is priced on, and free input images cost nothing', () => {
    const prices = [price('output_images', '0.018'), price('input_images', '0')];
    const result = assessImageCost({
      usage: imageUsage({ inputImages: 2, outputTokens: 4175 }),
      prices,
      reportedCost: null,
      variant: '',
    });
    expect(result.lines.map((l) => [l.metric, l.quantity])).toEqual([
      ['output_images', 1],
      ['input_images', 2],
    ]);
    expect(result.estimatedCost?.toString()).toBe('0.018');
  });

  it('is unknown, never zero, when a priced quantity was not reported or nothing is priced', () => {
    const tokenPriced = [price('output_image_tokens', '0.00006')];
    expect(
      assessImageCost({
        usage: imageUsage({}),
        prices: tokenPriced,
        reportedCost: null,
        variant: '',
      }).status,
    ).toBe('unknown');
    expect(
      assessImageCost({ usage: imageUsage({}), prices: [], reportedCost: null, variant: '' })
        .status,
    ).toBe('unknown');
    const reported = assessImageCost({
      usage: imageUsage({ outputTokens: 1290 }),
      prices: tokenPriced,
      reportedCost: UsdAmount.parse('0.0774'),
      variant: '',
    });
    expect([reported.status, reported.estimatedCost?.toString()]).toEqual(['reported', '0.0774']);
  });

  it('prices per megapixel through per-pixel prices', () => {
    const prices = [price('output_pixels', '0.000000014')]; // $0.014 per megapixel
    const result = assessImageCost({
      usage: imageUsage({ outputPixels: 1_000_000 }),
      prices,
      reportedCost: null,
      variant: '',
    });
    expect(result.estimatedCost?.toString()).toBe('0.014');
  });

  it('estimates before generation, unknown for token-priced models', () => {
    expect(
      estimateImageCost({
        prices: [price('output_images', '0.018')],
        count: 3,
        references: 1,
        resolution: '2K',
        aspectRatio: '9:16',
      })?.toString(),
    ).toBe('0.054');
    expect(
      estimateImageCost({
        prices: [price('output_image_tokens', '0.00006')],
        count: 1,
        references: 0,
        resolution: '1K',
        aspectRatio: '9:16',
      }),
    ).toBeNull();
    expect(approximatePixels('2K', '9:16')).toBe(2048 * 1152);
  });

  it('keeps LLM pricing on general (untiered) prices only', () => {
    const active = activePrices(
      [price('input_tokens', '0.000001'), price('input_tokens', '0.5', { variant: '2k' })],
      day(5),
    );
    expect(priceFor(active, 'input_tokens', 10)?.unitPrice.toString()).toBe('0.000001');
  });
});
