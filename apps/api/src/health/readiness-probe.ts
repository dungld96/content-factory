import type { ReadinessCheckName } from '@acf/contracts';

/** A dependency check. Resolve when healthy; reject (or hang) when not. */
export type ReadinessProbe = () => Promise<void>;

export type ReadinessProbes = Readonly<Record<ReadinessCheckName, ReadinessProbe>>;

export const READINESS_PROBES = Symbol('READINESS_PROBES');

export class ProbeTimeoutError extends Error {
  override readonly name = 'ProbeTimeoutError';
}
