import { describe, expect, it } from 'vitest';

import { UsdAmount } from '@acf/ai-core';

import {
  MIXROUTE_CATALOG_KEYS,
  mixRouteSourceUrl,
  planMixRouteImageImport,
  planMixRouteTextImport,
} from './mixroute-catalog.js';

describe('MixRoute curated catalog', () => {
  it('records per-token prices from the published per-1M prices, with the >100K tier', () => {
    const [haiku] = planMixRouteTextImport(['claude-haiku-5-5']);
    expect(haiku?.ok).toBe(true);
    if (!haiku?.ok) return;
    const input = haiku.model.prices.filter((p) => p.metric === 'input_tokens');
    expect(input.map((p) => [p.minPromptTokens, p.unitPrice.toString()])).toEqual([
      [0, '0.0000001'],
      [100_001, '0.0000005'],
    ]);
    expect(haiku.model.supportedParameters).toContain('structured_outputs');
    expect(haiku.model.isFreeVariant).toBe(false);
  });

  it('keeps every price exact (no rounding at 18 decimals)', () => {
    for (const entry of planMixRouteTextImport(MIXROUTE_CATALOG_KEYS.llm)) {
      if (!entry.ok) throw new Error(entry.reason);
      for (const p of entry.model.prices) {
        expect(UsdAmount.isExact(`${p.sourceValue.replace('/1M', '')}e-6`)).toBe(true);
      }
    }
  });

  it('describes Seedream as one image per call, two tiers, no seed, per-image prices', () => {
    const [seedream] = planMixRouteImageImport(['doubao-seedream-5-5-261028']);
    expect(seedream?.ok).toBe(true);
    if (!seedream?.ok) return;
    expect(seedream.model.constraints).toEqual({
      maxImages: 1,
      maxReferences: 10,
      aspectRatios: ['9:16', '1:1', '16:9'],
      resolutions: ['1.5K', '2K'],
      seed: false,
    });
    expect(seedream.model.prices.map((p) => [p.metric, p.variant, p.unitPrice.toString()])).toEqual(
      [
        ['output_images', '', '0.0195'],
        ['input_images', '', '0.0075'],
      ],
    );
  });

  it('imports any text model MixRoute offers the key, without prices', () => {
    const available = new Set(['qwen3-max', 'claude-haiku-5-5']);
    const [qwen, missing] = planMixRouteTextImport(['qwen3-max', 'gpt-6.1-sol'], available);
    expect(qwen).toMatchObject({
      ok: true,
      model: { modelKey: 'qwen3-max', displayName: 'qwen3-max (MixRoute)', prices: [] },
    });
    if (qwen?.ok) expect(qwen.model.warnings.join(' ')).toContain('No price recorded');
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('not offered') });
  });

  it('warns when a verified model is not listed for the key', () => {
    const [haiku] = planMixRouteTextImport(['claude-haiku-5-5'], new Set(['deepseek-v4-pro']));
    expect(haiku?.ok).toBe(true);
    if (haiku?.ok) expect(haiku.model.warnings.join(' ')).toContain('does not list this model');
    const [listed] = planMixRouteTextImport(['claude-haiku-5-5'], new Set(['claude-haiku-5-5']));
    if (listed?.ok) expect(listed.model.warnings.join(' ')).not.toContain('does not list');
  });

  it('without the model list, only verified models import', () => {
    expect(planMixRouteTextImport(['qwen3-max'])[0]).toMatchObject({
      ok: false,
      reason: expect.stringContaining('model list unavailable'),
    });
    expect(planMixRouteTextImport(['claude-haiku-5-5'])[0]).toMatchObject({ ok: true });
  });

  it('images: other Seedream ids get the Seedream limits; other families are refused', () => {
    const available = new Set(['dola-seedream-5.5', 'gpt-image-2']);
    const [dola, gpt] = planMixRouteImageImport(['dola-seedream-5.5', 'gpt-image-2'], available);
    expect(dola).toMatchObject({
      ok: true,
      model: { modelKey: 'dola-seedream-5.5', prices: [], constraints: { maxImages: 1 } },
    });
    expect(gpt).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Seedream and Gemini'),
    });
  });

  it('Gemini image: verified price per image, one image, no resolution; listed ids import', () => {
    const [flash] = planMixRouteImageImport(
      ['gemini-2.5-flash-image'],
      new Set(['gemini-2.5-flash-image']),
    );
    expect(flash).toMatchObject({
      ok: true,
      model: { constraints: { maxImages: 1, resolutions: [], seed: false } },
    });
    if (flash?.ok) expect(flash.model.prices.map((p) => p.unitPrice.toString())).toEqual(['0.039']);
    const [other] = planMixRouteImageImport(
      ['gemini-3.1-flash-image'],
      new Set(['gemini-3.1-flash-image']),
    );
    expect(other).toMatchObject({ ok: true, model: { prices: [] } });
  });

  it('refuses keys it does not know, and points each model at its official page', () => {
    expect(planMixRouteTextImport(['gpt-6.1-sol'])[0]).toMatchObject({ ok: false });
    expect(planMixRouteImageImport(['claude-haiku-5-5'])[0]).toMatchObject({ ok: false });
    expect(mixRouteSourceUrl('gemini-3.5-flash-lite')).toBe(
      'https://mixroute.ai/models/gemini-3-5-flash-lite/',
    );
  });
});
