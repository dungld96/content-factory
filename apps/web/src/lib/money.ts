import type { JobCostDto } from '@acf/contracts';

/**
 * Exact decimal USD arithmetic for display (CLAUDE.md §5: no floating-point money). Amounts are
 * the API's decimal strings (`UsdAmount`, e.g. "0.0042"); they are summed as scaled integers.
 */
const USD_PATTERN = /^\d+(\.\d+)?$/;

function parse(amount: string): { units: bigint; scale: number } {
  if (!USD_PATTERN.test(amount)) throw new Error(`not a USD amount: ${amount}`);
  const [whole = '0', fraction = ''] = amount.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

export function addUsd(...amounts: readonly string[]): string {
  if (amounts.length === 0) return '0';
  const parsed = amounts.map(parse);
  const scale = Math.max(...parsed.map((p) => p.scale));
  const total = parsed.reduce((sum, p) => sum + p.units * 10n ** BigInt(scale - p.scale), 0n);
  if (scale === 0) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  const whole = digits.slice(0, -scale);
  return fraction ? `${whole}.${fraction}` : whole;
}

/** "$0.084", "$1.50", "$0": at least two decimals once there is a fraction, never rounded. */
export function formatUsd(amount: string): string {
  const [whole = '0', fraction = ''] = addUsd(amount).split('.');
  if (!fraction) return `$${whole}`;
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

/** Sum of several jobs' costs, keeping reported, estimated and unknown apart (ADR-0012). */
export function sumJobCosts(costs: readonly JobCostDto[]): JobCostDto {
  return {
    calls: costs.reduce((n, c) => n + c.calls, 0),
    reportedUsd: addUsd(...costs.map((c) => c.reportedUsd)),
    estimatedUsd: addUsd(...costs.map((c) => c.estimatedUsd)),
    unknownCalls: costs.reduce((n, c) => n + c.unknownCalls, 0),
  };
}
