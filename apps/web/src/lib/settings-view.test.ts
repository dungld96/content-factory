import { describe, expect, it } from 'vitest';

import type { AiPriceDto, AiProviderDto, AiRegistryEventDto, AiRouteDto } from '@acf/contracts';

import { changeSummary, keyStatus, routeReadiness } from './ai-settings-view';
import { compactCount, displayUsd, priceLine, primaryPrices, shiftDecimal } from './price-format';

const price = (
  metric: AiPriceDto['metric'],
  unitPriceUsd: string,
  extra: Partial<AiPriceDto> = {},
) =>
  ({
    id: `${metric}-${unitPriceUsd}`,
    metric,
    unitPriceUsd,
    minPromptTokens: 0,
    variant: '',
    ...extra,
  }) as AiPriceDto;

describe('price formatting', () => {
  it('moves the decimal point exactly', () => {
    expect(shiftDecimal('0.00000015', 6)).toBe('0.15');
    expect(shiftDecimal('0.000000625', 6)).toBe('0.625');
    expect(shiftDecimal('3', 6)).toBe('3000000');
    expect(shiftDecimal('0.05', 0)).toBe('0.05');
    expect(shiftDecimal('0', 6)).toBe('0');
  });

  it('shows at most four decimals, marking rounded values', () => {
    expect(displayUsd('0.15')).toBe('$0.15');
    expect(displayUsd('3')).toBe('$3');
    expect(displayUsd('0.5')).toBe('$0.50');
    expect(displayUsd('0.0833333333')).toBe('≈ $0.0833');
    expect(displayUsd('0.99999')).toBe('≈ $1');
  });

  it('labels prices in the units people compare', () => {
    expect(priceLine(price('input_tokens', '0.00000015')).price).toBe('$0.15 / 1M tokens');
    expect(
      priceLine(price('output_video_seconds', '0.05', { variant: '720p-silent' })),
    ).toMatchObject({
      label: 'Video · 720p-silent',
      price: '$0.05 / second',
    });
    expect(priceLine(price('input_tokens', '0.0000003', { minPromptTokens: 200_000 })).label).toBe(
      'Input (prompts ≥ 200K)',
    );
    expect(
      primaryPrices([
        price('cached_input_tokens', '0.00000001'),
        price('output_tokens', '0.000005'),
        price('input_tokens', '0.000001'),
      ]).map((l) => l.label),
    ).toEqual(['Input', 'Output']);
  });
});

describe('compactCount', () => {
  it('reads token counts at a glance', () => {
    expect(compactCount(128_000)).toBe('128K');
    expect(compactCount(1_000_000)).toBe('1M');
    expect(compactCount(1_048_576)).toBe('1M');
    expect(compactCount(1_500_000)).toBe('1.5M');
  });
});

describe('route readiness and key status', () => {
  const providers = [
    { key: 'mock', kind: 'mock', status: 'enabled', configured: false },
    { key: 'openrouter', kind: 'gateway', status: 'enabled', configured: true },
  ] as AiProviderDto[];
  const route = (
    provider: AiRouteDto['provider'],
    modelStatus: 'enabled' | 'disabled' = 'enabled',
  ) =>
    ({
      task: 'script_generation',
      model: { id: 'm', modelKey: 'x', displayName: 'X', status: modelStatus },
      provider,
      zeroDataRetention: false,
      updatedAt: null,
    }) as AiRouteDto;

  it('names the first thing to fix', () => {
    expect(
      routeReadiness(route({ key: 'openrouter', status: 'enabled', configured: true }), providers),
    ).toEqual({
      ready: true,
    });
    expect(
      routeReadiness(route({ key: 'mock', status: 'enabled', configured: false }), providers),
    ).toEqual({ ready: false, reason: 'Test-only provider, not active here' });
    expect(
      routeReadiness(
        route({ key: 'openrouter', status: 'enabled', configured: true }, 'disabled'),
        providers,
      ),
    ).toEqual({ ready: false, reason: 'Model disabled' });
  });

  it('describes keys without exposing them', () => {
    expect(keyStatus(providers[1] as AiProviderDto)).toEqual({
      label: 'API key configured',
      ok: true,
    });
    expect(keyStatus(providers[0] as AiProviderDto).label).toBe('Test provider (tests only)');
  });
});

describe('registry change summary', () => {
  const event = (before: unknown, after: unknown) => ({ before, after }) as AiRegistryEventDto;
  it('reads as before → after', () => {
    expect(changeSummary(event({ status: 'disabled' }, { status: 'enabled' }))).toBe(
      'disabled → enabled',
    );
    expect(changeSummary(event(null, { action: 'created', newPrices: 3 }))).toBe(
      'action created, newPrices 3',
    );
  });
});
