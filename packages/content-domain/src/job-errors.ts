// Every code a generation job can end with (P3 design W3). Browser-safe: exported through
// `@acf/content-domain/schemas` for @acf/contracts and the web app.
import type { ProviderErrorCode } from '@acf/ai-core';

/** Normalized provider codes (`ProviderErrorCode` in @acf/ai-core), passed through unchanged. */
const PROVIDER_CODES = [
  'AUTHENTICATION',
  'PERMISSION_DENIED',
  'CONTENT_POLICY',
  'PROVIDER_BUDGET_EXCEEDED',
  'INVALID_REQUEST',
  'CONTEXT_LENGTH_EXCEEDED',
  'UNSUPPORTED_PARAMETER',
  'MODEL_NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK',
  'EMPTY_OUTPUT',
  'MALFORMED_RESPONSE',
  'PROVIDER_ERROR',
] as const;

export const JOB_ERROR_CODES = [
  ...PROVIDER_CODES,
  // Job layer (worker).
  'OUTPUT_INVALID',
  'NO_ELIGIBLE_MODEL',
  'MODEL_LIMITS',
  'INVALID_JOB_INPUT',
  'INTERNAL_ERROR',
  'WORKER_LOST',
  'BUDGET_EXCEEDED',
  'PROVIDER_CIRCUIT_OPEN',
  'REFERENCE_MISSING',
  'STORAGE_NOT_CONFIGURED',
  'STORAGE_UNAVAILABLE',
  'CHECKSUM_MISMATCH',
  'OBJECT_TOO_LARGE',
  'MEDIA_TOOLS_MISSING',
  // A paid call whose outcome could not be confirmed (never retried automatically).
  'SUBMIT_OUTCOME_UNKNOWN',
  'CALL_OUTCOME_UNKNOWN',
  // Asynchronous video jobs.
  'PROVIDER_TIMEOUT',
  'PROVIDER_FAILED',
  'PROVIDER_CANCELLED',
  'PROVIDER_EXPIRED',
  'OUTPUT_EXPIRED',
  // Renders.
  'RENDER_INPUT_INVALID',
  'RENDER_QC_FAILED',
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

// Compile-time checks: every provider code is a job code, and the list above matches the enum.
type Missing = Exclude<ProviderErrorCode, (typeof PROVIDER_CODES)[number]>;
type Extra = Exclude<(typeof PROVIDER_CODES)[number], ProviderErrorCode>;
export type ProviderCodesMatch = [Missing, Extra] extends [never, never] ? true : never;
// Fails to compile if `ProviderErrorCode` and `PROVIDER_CODES` ever differ.
export const PROVIDER_CODES_MATCH: ProviderCodesMatch = true;

const CODES: ReadonlySet<string> = new Set(JOB_ERROR_CODES);

export function isJobErrorCode(code: string): code is JobErrorCode {
  return CODES.has(code);
}

/** The job code for a terminal, unsuccessful provider status of a video job. */
export function videoFailureCode(status: 'failed' | 'cancelled' | 'expired'): JobErrorCode {
  return status === 'cancelled'
    ? 'PROVIDER_CANCELLED'
    : status === 'expired'
      ? 'PROVIDER_EXPIRED'
      : 'PROVIDER_FAILED';
}
