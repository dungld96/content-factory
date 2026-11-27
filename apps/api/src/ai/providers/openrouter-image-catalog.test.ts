import { describe, expect, it } from 'vitest';

import { planImageModel } from './openrouter-image-catalog.js';

// Shapes copied from the public catalog on 2026-11-18 (verification record §2).
const seedream = {
  id: 'bytedance-seed/seedream-5-0-flash',
  endpoints: [
    {
      provider_slug: 'seed',
      provider_tag: 'seed',
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '9:16', '16:9'] },
        n: { type: 'range', min: 1, max: 1 },
        input_references: { type: 'range', min: 0, max: 14 },
        resolution: { type: 'enum', values: ['1K', '1.5K', '2K'] },
        seed: { type: 'boolean' },
      },
      pricing: [
        { billable: 'output_image', unit: 'image', cost_usd: 0.018 },
        { billable: 'input_image', unit: 'image', cost_usd: 0 },
      ],
    },
  ],
};

describe('planImageModel', () => {
  it('maps constraints and per-image prices', () => {
    const plan = planImageModel(seedream);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.model).toMatchObject({
      endpoint: 'seed',
      supportedParameters: ['aspect_ratio', 'input_references', 'n', 'resolution', 'seed'],
      constraints: {
        maxImages: 1,
        maxReferences: 14,
        aspectRatios: ['1:1', '9:16', '16:9'],
        resolutions: ['1K', '1.5K', '2K'],
        seed: true,
      },
      warnings: [],
    });
    expect(
      plan.model.prices.map((p) => [p.metric, p.variant, p.sourceValue, p.unitPrice.toString()]),
    ).toEqual([
      ['output_images', '', '0.018', '0.018'],
      ['input_images', '', '0', '0'],
    ]);
  });

  it('keeps resolution tiers and converts per-megapixel to per-pixel prices', () => {
    const plan = planImageModel({
      id: 'black-forest-labs/flux.2-pro',
      endpoints: [
        {
          provider_slug: 'black-forest-labs',
          supported_parameters: { aspect_ratio: { type: 'enum', values: ['9:16'] } },
          pricing: [
            { billable: 'output_image', unit: 'megapixel', cost_usd: 0.03 },
            { billable: 'output_image', unit: 'image', cost_usd: 0.014, variant: '2k' },
          ],
        },
      ],
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.model.prices.map((p) => [p.metric, p.variant, p.unitPrice.toString()])).toEqual([
      ['output_pixels', '', '0.00000003'],
      ['output_images', '2k', '0.014'],
    ]);
    expect(plan.model.constraints).toMatchObject({ maxImages: 1, maxReferences: 0, seed: false });
  });

  it('maps token prices, warns about unrepresentable lines and several endpoints', () => {
    const plan = planImageModel({
      id: 'google/gemini-3.1-flash-image',
      endpoints: [
        {
          provider_slug: 'google-vertex/us',
          supported_parameters: {},
          pricing: [
            { billable: 'output_image', unit: 'token', cost_usd: 0.000066 },
            { billable: 'input_text', unit: 'token', cost_usd: 0.000005 },
          ],
        },
        { provider_slug: 'google-ai-studio', supported_parameters: {}, pricing: [] },
      ],
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.model.prices.map((p) => [p.metric, p.sourceValue])).toEqual([
      ['output_image_tokens', '0.000066'],
    ]);
    expect(plan.model.warnings).toEqual([
      '2 endpoints; prices and limits from google-vertex/us (others may differ)',
      'price input_text/token not representable; reported cost covers it',
    ]);
    const preferred = planImageModel(
      {
        id: 'google/gemini-3.1-flash-image',
        endpoints: [
          ...[{ provider_slug: 'a', supported_parameters: {}, pricing: [] }],
          { provider_slug: 'b', supported_parameters: {}, pricing: [] },
        ],
      },
      'b',
    );
    expect(preferred.ok && preferred.model.endpoint).toBe('b');
  });

  it('refuses a model without endpoints', () => {
    expect(planImageModel({ id: 'x/y', endpoints: [] })).toEqual({
      ok: false,
      modelKey: 'x/y',
      reason: 'no endpoints',
    });
  });
});
