/**
 * When a paid action asks before it runs (redesign R-D4): the known total is above the effective
 * threshold, or any price is unknown (always asked, whatever the threshold). Amounts are the
 * API's decimal USD strings, compared exactly as scaled integers.
 */
export type ConfirmReason = 'threshold' | 'unknown';

const SCALE = 6;

function micros(usd: string): bigint {
  const [whole = '0', fraction = ''] = usd.split('.');
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0').slice(0, SCALE));
}

export function confirmReasons(input: {
  /** Known part of the total; `null` when nothing is priced. */
  readonly totalUsd: string | null;
  readonly unknown: boolean;
  readonly thresholdUsd: string;
}): ConfirmReason[] {
  const reasons: ConfirmReason[] = [];
  if (input.totalUsd !== null && micros(input.totalUsd) > micros(input.thresholdUsd)) {
    reasons.push('threshold');
  }
  if (input.unknown || input.totalUsd === null) reasons.push('unknown');
  return reasons;
}
