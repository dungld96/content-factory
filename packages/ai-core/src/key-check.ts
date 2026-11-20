/**
 * Result of checking a provider credential without a paid call (P1 design O3). Never carries the
 * credential or request headers.
 */
export interface KeyCheckResult {
  readonly result: 'valid' | 'rejected' | 'unreachable';
  /** The provider's HTTP status, when it answered. */
  readonly httpStatus: number | null;
  /** Remaining spend limit of the key, as the provider reports it; null when not reported. */
  readonly limitRemaining: number | null;
  /** Usage recorded on the key, as the provider reports it; null when not reported. */
  readonly usage: number | null;
  readonly isFreeTier: boolean | null;
}
