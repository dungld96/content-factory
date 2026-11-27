import { describe, expect, it } from 'vitest';

import {
  countByStage,
  isInProduction,
  matchesStatusFilter,
  needsReview,
  statusInfo,
  weeklyCreation,
} from './content-status';
import { countedLines, initials, specLabel } from './format';
import { addUsd, formatUsd, formatUsdSummary, sumJobCosts } from './money';

describe('money', () => {
  it('adds decimal strings exactly', () => {
    expect(addUsd('0.1', '0.2')).toBe('0.3');
    expect(addUsd('0.0042', '1.5', '0')).toBe('1.5042');
    expect(addUsd('0.000001', '0.999999')).toBe('1');
    expect(addUsd()).toBe('0');
  });

  it('rejects anything that is not a USD amount', () => {
    expect(() => addUsd('-1')).toThrow();
    expect(() => addUsd('1e3')).toThrow();
  });

  it('formats without rounding', () => {
    expect(formatUsd('0')).toBe('$0');
    expect(formatUsd('1.5')).toBe('$1.50');
    expect(formatUsd('0.0840')).toBe('$0.084');
    expect(formatUsd('0.000123')).toBe('$0.000123');
  });

  it('rounds summary figures to cents, half-up; tiny amounts are <$0.01', () => {
    expect(formatUsdSummary('1.651570623')).toBe('$1.65');
    expect(formatUsdSummary('1.655')).toBe('$1.66');
    expect(formatUsdSummary('20')).toBe('$20.00');
    expect(formatUsdSummary('0')).toBe('$0.00');
    expect(formatUsdSummary('0.004')).toBe('<$0.01');
    expect(formatUsdSummary('0.005')).toBe('$0.01');
  });

  it('keeps reported, estimated and unknown cost apart', () => {
    expect(
      sumJobCosts([
        { calls: 1, reportedUsd: '0.01', estimatedUsd: '0', unknownCalls: 0 },
        { calls: 2, reportedUsd: '0', estimatedUsd: '0.005', unknownCalls: 1 },
      ]),
    ).toEqual({ calls: 3, reportedUsd: '0.01', estimatedUsd: '0.005', unknownCalls: 1 });
  });
});

describe('content status', () => {
  it('labels every status for people', () => {
    expect(statusInfo('script_review')).toEqual({
      label: 'status.script_review',
      tone: 'amber',
      stage: 'script',
    });
    expect(statusInfo('exported').stage).toBe('done');
  });

  it('classifies production and review states', () => {
    expect(isInProduction('draft')).toBe(false);
    expect(isInProduction('generating_assets')).toBe(true);
    expect(isInProduction('approved')).toBe(false);
    expect(needsReview('asset_review')).toBe(true);
    expect(needsReview('scripting')).toBe(false);
    expect(matchesStatusFilter('exported', 'approved')).toBe(true);
    expect(matchesStatusFilter('canceled', 'attention')).toBe(true);
  });

  it('counts by stage in board order', () => {
    const counts = countByStage(['draft', 'script_review', 'scripting', 'asset_review']);
    expect(counts.map((c) => c.stage)).toEqual([
      'draft',
      'script',
      'storyboard',
      'images',
      'render',
      'done',
      'attention',
    ]);
    expect(counts.find((c) => c.stage === 'script')).toEqual({
      stage: 'script',
      total: 2,
      waiting: 1,
    });
  });

  it('buckets creation by UTC week, Monday first, current week last', () => {
    const now = new Date('2026-11-19T10:00:00Z'); // a Thursday
    const weeks = weeklyCreation(
      [
        { createdAt: '2026-11-16T00:00:00Z', status: 'approved' }, // Monday of this week
        { createdAt: '2026-11-15T23:59:59Z', status: 'draft' }, // Sunday of last week
        { createdAt: '2026-09-01T00:00:00Z', status: 'draft' }, // outside the window
      ],
      now,
      2,
    );
    expect(weeks).toEqual([
      { weekStart: '2026-11-09', created: 1, finished: 0 },
      { weekStart: '2026-11-16', created: 1, finished: 1 },
    ]);
  });
});

describe('format', () => {
  it('counts repeated lines once each, in order (unique React keys)', () => {
    expect(countedLines(['a', 'b', 'a', 'a'])).toEqual([
      { text: 'a', count: 3 },
      { text: 'b', count: 1 },
    ]);
  });

  it('builds initials and specs', () => {
    expect(initials('Demo Studio')).toBe('DS');
    expect(initials('studio')).toBe('ST');
    expect(initials('  ')).toBe('?');
    expect(specLabel({ targetDurationSeconds: 30, aspectRatio: '9:16', language: 'vi' })).toBe(
      '30s · 9:16 · VI',
    );
  });
});
