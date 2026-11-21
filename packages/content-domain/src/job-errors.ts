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
  // P3d: a paid output was delivered but could not be stored; it is lost (known cost).
  'OUTPUT_NOT_STORED',
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

/**
 * Job endings after which the provider may still charge for a call it may have received
 * (video submissions; text and speech calls, P3 W5): the reservation is held for an owner to
 * resolve, and a resume needs the user's explicit consent to a possible double charge.
 */
export const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  'SUBMIT_OUTCOME_UNKNOWN',
  'CALL_OUTCOME_UNKNOWN',
]);

/**
 * Job endings that a resume repeats only with the user's consent to paying again: the outcome
 * is unknown (above), or the output was paid for and lost (`OUTPUT_NOT_STORED`, P3d R5). Only the
 * first group holds the reservation; a lost output's charge is already in the ledger.
 */
export const DOUBLE_CHARGE_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  'SUBMIT_OUTCOME_UNKNOWN',
  'CALL_OUTCOME_UNKNOWN',
  'OUTPUT_NOT_STORED',
]);

/**
 * P3d R3: a clip or voice-over job that failed with one of these codes **after** its output was
 * delivered is finished from the delivered file (no provider call, no cost). The file itself was
 * fine as far as anyone knows: the failure was the environment's.
 */
export const FINISHABLE_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  'MEDIA_TOOLS_MISSING',
  'STORAGE_UNAVAILABLE',
  'WORKER_LOST',
  'INTERNAL_ERROR',
]);

/** Whether a failed job can be finished without calling the provider again (P3d R3). */
export function isFinishable(job: {
  readonly kind: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly deliveredAt: Date | string | null;
}): boolean {
  return (
    job.status === 'failed' &&
    (job.kind === 'video_generation' || job.kind === 'tts_generation') &&
    job.deliveredAt !== null &&
    job.errorCode !== null &&
    FINISHABLE_CODES.has(job.errorCode)
  );
}

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
