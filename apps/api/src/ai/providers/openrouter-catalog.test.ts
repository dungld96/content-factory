import { describe, expect, it } from 'vitest';

import { UsdAmount, type PriceComponent } from '@acf/ai-core';

import { smokeWorstCase } from '../../cli/ai-registry-cli.js';
import { planCatalogModel } from './openrouter-catalog.js';

const base = {
  id: 'x/model',
  name: 'X',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['max_tokens', 'tools', 'seed', 'reasoning'],
};

describe('planCatalogModel', () => {
  it('keeps a prompt-size tier even when the override has extra price fields', () => {
    const plan = planCatalogModel({
      ...base,
      pricing: {
        prompt: '0.0000001',
        completion: '0.0000005',
        input_cache_write_1h: '0.0000002',
        overrides: [
          {
            min_prompt_tokens: 100_000,
            prompt: '0.0000005',
            completion: '0.0000025',
            input_cache_write_1h: '0.000001',
          },
        ],
      },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.model.prices.map((p) => [p.metric, p.minPromptTokens, p.sourceValue])).toEqual([
      ['input_tokens', 0, '0.0000001'],
      ['output_tokens', 0, '0.0000005'],
      ['input_tokens', 100_000, '0.0000005'],
      ['output_tokens', 100_000, '0.0000025'],
    ]);
    expect(plan.model.warnings).toEqual([
      'price field "input_cache_write_1h" not imported (does not apply to text calls)',
    ]);
    // Only parameters the adapter understands are recorded.
    expect(plan.model.supportedParameters).toEqual(['max_tokens', 'seed']);
  });

  it('skips a time-conditioned override with a warning (the registry cannot represent it)', () => {
    const plan = planCatalogModel({
      ...base,
      pricing: {
        prompt: '0.0000001',
        completion: '0.0000005',
        overrides: [{ utc_days: [6, 0], prompt: '0.00000005', completion: '0.00000025' }],
      },
    });
    expect(plan.ok && plan.model.prices).toHaveLength(2);
    expect(plan.ok && plan.model.warnings[0]).toContain('utc_days');
  });

  it('flags free variants and parses expiry', () => {
    const plan = planCatalogModel({
      ...base,
      id: 'x/model:free',
      pricing: { prompt: '0', completion: '0' },
      expiration_date: '2026-12-31',
    });
    expect(plan.ok && plan.model).toMatchObject({
      isFreeVariant: true,
      expiresAt: new Date('2026-12-31'),
    });
  });

  it.each([
    [{ ...base, pricing: { prompt: 'cheap', completion: '0' } }, 'unparseable prompt price'],
    [{ id: 42 }, 'does not match the documented shape'],
  ])('refuses %o', (entry, reason) => {
    const plan = planCatalogModel(entry);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain(reason);
  });
});

describe('smokeWorstCase', () => {
  const price = (metric: PriceComponent['metric'], usd: string): PriceComponent => ({
    id: metric,
    metric,
    unitPrice: UsdAmount.parse(usd),
    minPromptTokens: 0,
    effectiveFrom: new Date(0),
  });

  it('bounds prompt bytes + overhead at the input price and 16 tokens at the dearest output price, ×10', () => {
    const worst = smokeWorstCase([
      price('input_tokens', '0.000001'),
      price('output_tokens', '0.000002'),
      price('reasoning_tokens', '0.00001'),
      price('request', '0.0005'),
    ]);
    // (prompt bytes 29 + 30 = 59, + 32 overhead = 91 tokens × 1e-6; 16 × 1e-5; + 0.0005) × 10
    expect(worst?.toString()).toBe('0.00751');
  });

  it('is unknown without input and output prices', () => {
    expect(smokeWorstCase([price('input_tokens', '1')])).toBeNull();
  });
});
