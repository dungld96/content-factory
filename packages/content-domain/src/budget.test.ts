import { PriceMetric, UsdAmount, type PriceComponent } from '@acf/ai-core';
import { describe, expect, it } from 'vitest';

import {
  budgetMonth,
  estimateTextJob,
  findBudgetBreach,
  reservationAmount,
  type BudgetLimits,
} from './budget.js';

const usd = (v: string) => UsdAmount.parse(v);
const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({
  monthlyLimit: usd('10'),
  monthlyMode: 'hard',
  itemLimit: usd('3'),
  itemMode: 'soft',
  requestLimit: usd('2'),
  requestMode: 'hard',
  ...over,
});
const price = (metric: PriceComponent['metric'], unitPrice: string): PriceComponent => ({
  id: metric,
  metric,
  unitPrice: usd(unitPrice),
  minPromptTokens: 0,
  variant: '',
  effectiveFrom: new Date(0),
});

describe('findBudgetBreach', () => {
  const usage = { month: usd('7'), item: usd('1') };

  it('allows a request that exactly reaches every limit', () => {
    expect(findBudgetBreach(limits(), { month: usd('8'), item: usd('1') }, usd('2'))).toBeNull();
  });

  it('checks the request, then the item, then the month', () => {
    expect(findBudgetBreach(limits(), usage, usd('2.5'))).toMatchObject({
      scope: 'request',
      mode: 'hard',
    });
    expect(
      findBudgetBreach(limits(), { month: usd('0'), item: usd('2') }, usd('1.5')),
    ).toMatchObject({
      scope: 'item',
      mode: 'soft',
      spent: usd('2'),
    });
    expect(findBudgetBreach(limits(), usage, usd('1.5'))).toBeNull();
    expect(
      findBudgetBreach(limits(), { month: usd('9'), item: usd('0') }, usd('1.5')),
    ).toMatchObject({
      scope: 'month',
      mode: 'hard',
      limit: usd('10'),
      spent: usd('9'),
      requested: usd('1.5'),
    });
  });

  it('never lets a soft breach hide a hard one', () => {
    // Item (soft) and month (hard) are both exceeded: the hard one decides.
    expect(
      findBudgetBreach(limits(), { month: usd('9'), item: usd('2.5') }, usd('1.5')),
    ).toMatchObject({
      scope: 'month',
      mode: 'hard',
    });
    const allSoft = limits({ monthlyMode: 'soft' });
    expect(
      findBudgetBreach(allSoft, { month: usd('9'), item: usd('2.5') }, usd('1.5')),
    ).toMatchObject({
      scope: 'item',
      mode: 'soft',
    });
  });

  it('skips absent optional limits', () => {
    const open = limits({ requestLimit: null, itemLimit: null });
    expect(findBudgetBreach(open, { month: usd('0'), item: usd('50') }, usd('9'))).toBeNull();
  });

  it('treats a zero monthly limit as no paid work at all', () => {
    expect(
      findBudgetBreach(limits({ monthlyLimit: usd('0') }), usage, usd('0.000001')),
    ).toMatchObject({
      scope: 'month',
    });
  });
});

describe('reservationAmount', () => {
  it('reserves the estimate, or the placeholder per call when unknown (never zero)', () => {
    expect(reservationAmount(usd('0.12'))).toEqual({ amount: usd('0.12'), kind: 'estimate' });
    expect(reservationAmount(null, 3)).toEqual({ amount: usd('1.5'), kind: 'unknown_placeholder' });
  });
});

describe('budgetMonth', () => {
  it('is the UTC calendar month', () => {
    const m = budgetMonth(new Date('2026-12-31T23:59:59Z'));
    expect(m.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(m.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('estimateTextJob', () => {
  it('prices the worst case twice (one repair call)', () => {
    const prices = [
      price(PriceMetric.INPUT_TOKENS, '0.000001'),
      price(PriceMetric.OUTPUT_TOKENS, '0.000002'),
    ];
    // script: (6000 × 1e-6 + 4000 × 2e-6) × 2 = 0.028
    expect(estimateTextJob('script_generation', prices)).toEqual({
      estimate: usd('0.028'),
      calls: 2,
    });
  });

  it('is unknown when a billed metric has no price', () => {
    expect(
      estimateTextJob('storyboard_generation', [price(PriceMetric.INPUT_TOKENS, '0.000001')]),
    ).toEqual({
      estimate: null,
      calls: 2,
    });
  });
});
