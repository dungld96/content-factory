import { describe, expect, it } from 'vitest';

import { confirmReasons } from './cost-confirm';

describe('confirmReasons (R-D4)', () => {
  it('runs at or below the threshold with known prices', () => {
    expect(confirmReasons({ totalUsd: '1', unknown: false, thresholdUsd: '1' })).toEqual([]);
    expect(confirmReasons({ totalUsd: '0.42', unknown: false, thresholdUsd: '1' })).toEqual([]);
  });

  it('asks above the threshold, compared exactly', () => {
    expect(confirmReasons({ totalUsd: '1.000001', unknown: false, thresholdUsd: '1' })).toEqual([
      'threshold',
    ]);
    expect(confirmReasons({ totalUsd: '0.5', unknown: false, thresholdUsd: '0' })).toEqual([
      'threshold',
    ]);
  });

  it('always asks when a price is unknown, never treating it as $0', () => {
    expect(confirmReasons({ totalUsd: '0.2', unknown: true, thresholdUsd: '100' })).toEqual([
      'unknown',
    ]);
    expect(confirmReasons({ totalUsd: null, unknown: false, thresholdUsd: '100' })).toEqual([
      'unknown',
    ]);
    expect(confirmReasons({ totalUsd: '5', unknown: true, thresholdUsd: '1' })).toEqual([
      'threshold',
      'unknown',
    ]);
  });
});
