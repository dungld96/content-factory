import type { JobErrorCode } from '@acf/contracts';

/**
 * What a failed job means for the user (P3 design W3):
 * - `retry`: a passing problem; Resume or Regenerate.
 * - `input`: change the prompt, the input or the model, then regenerate.
 * - `operator`: configuration of the platform; an operator must act.
 * - `charged`: the provider may have charged already; resuming may be charged twice.
 */
export type JobErrorGroup = 'retry' | 'input' | 'operator' | 'charged';

export const JOB_ERROR_GROUP_LABEL: Readonly<Record<JobErrorGroup, string>> = {
  retry: 'Retry',
  input: 'Change the input',
  operator: 'Ask an operator',
  charged: 'Possibly charged',
};

const ERRORS: Readonly<
  Record<JobErrorCode, { readonly text: string; readonly group: JobErrorGroup }>
> = {
  AUTHENTICATION: { text: 'The provider rejected the API key.', group: 'operator' },
  PERMISSION_DENIED: { text: 'The API key may not use this model.', group: 'operator' },
  CONTENT_POLICY: {
    text: 'Blocked by the provider’s content policy. Change the prompt or the input image.',
    group: 'input',
  },
  PROVIDER_BUDGET_EXCEEDED: {
    text: 'The provider account has no credit left.',
    group: 'operator',
  },
  INVALID_REQUEST: {
    text: 'The model refused these parameters. Pick another model or setting.',
    group: 'input',
  },
  CONTEXT_LENGTH_EXCEEDED: {
    text: 'The input is too long for this model. Shorten it or pick another model.',
    group: 'input',
  },
  UNSUPPORTED_PARAMETER: {
    text: 'The model does not support a requested setting. Pick another model.',
    group: 'input',
  },
  MODEL_NOT_FOUND: { text: 'The provider no longer offers this model.', group: 'operator' },
  RATE_LIMITED: { text: 'The provider was busy. Try again.', group: 'retry' },
  PROVIDER_UNAVAILABLE: { text: 'The provider was unavailable. Try again later.', group: 'retry' },
  TIMEOUT: { text: 'The provider did not answer in time. Try again.', group: 'retry' },
  NETWORK: { text: 'The provider could not be reached. Try again.', group: 'retry' },
  EMPTY_OUTPUT: { text: 'The model returned nothing. Try again.', group: 'retry' },
  MALFORMED_RESPONSE: {
    text: 'The provider sent an unreadable answer. Try again.',
    group: 'retry',
  },
  PROVIDER_ERROR: { text: 'The provider failed. Try again.', group: 'retry' },
  OUTPUT_INVALID: {
    text: 'The result failed validation. Regenerate it.',
    group: 'retry',
  },
  NO_ELIGIBLE_MODEL: { text: 'No usable model is set up for this step.', group: 'operator' },
  MODEL_LIMITS: {
    text: 'The model cannot do this (size, length or references). Pick another model.',
    group: 'input',
  },
  INVALID_JOB_INPUT: { text: 'The job’s input was invalid. Regenerate it.', group: 'input' },
  INTERNAL_ERROR: { text: 'Something went wrong on the server. Try again.', group: 'retry' },
  WORKER_LOST: { text: 'The worker stopped during the job. Try again.', group: 'retry' },
  BUDGET_EXCEEDED: {
    text: 'The budget no longer covers this job. Raise the budget or wait for next month.',
    group: 'input',
  },
  PROVIDER_CIRCUIT_OPEN: {
    text: 'The provider is failing; work waits until it recovers.',
    group: 'retry',
  },
  REFERENCE_MISSING: {
    text: 'An input file is missing. Choose another reference, keyframe or clip.',
    group: 'input',
  },
  STORAGE_NOT_CONFIGURED: { text: 'File storage is not set up.', group: 'operator' },
  STORAGE_UNAVAILABLE: { text: 'File storage was unavailable. Try again.', group: 'retry' },
  CHECKSUM_MISMATCH: { text: 'A stored file was damaged. Try again.', group: 'retry' },
  OBJECT_TOO_LARGE: { text: 'The file is too large to store.', group: 'input' },
  MEDIA_TOOLS_MISSING: {
    text: 'FFmpeg or FFprobe is not installed on the worker. Install it (see the Windows guide in docs/LOCAL_DEVELOPMENT.md), then resume.',
    group: 'operator',
  },
  SUBMIT_OUTCOME_UNKNOWN: {
    text: 'The submission could not be confirmed. Resuming may be charged twice.',
    group: 'charged',
  },
  CALL_OUTCOME_UNKNOWN: {
    text: 'The provider call could not be confirmed. Resuming may be charged twice.',
    group: 'charged',
  },
  PROVIDER_TIMEOUT: {
    text: 'The provider did not finish in time; it may still charge.',
    group: 'charged',
  },
  PROVIDER_FAILED: { text: 'The provider failed to generate it. Regenerate.', group: 'retry' },
  PROVIDER_CANCELLED: { text: 'The provider cancelled the job. Regenerate.', group: 'retry' },
  PROVIDER_EXPIRED: { text: 'The provider expired the job. Regenerate.', group: 'retry' },
  OUTPUT_EXPIRED: {
    text: 'The provider deleted the output before download. Regenerate.',
    group: 'retry',
  },
  RENDER_INPUT_INVALID: {
    text: 'A chosen clip or voice-over cannot be used. Choose another.',
    group: 'input',
  },
  RENDER_QC_FAILED: {
    text: 'The render failed the automated checks (see the QC report).',
    group: 'input',
  },
};

export interface JobErrorInfo {
  readonly code: string;
  readonly text: string;
  /** `null` for codes this web build does not know (older rows). */
  readonly group: JobErrorGroup | null;
}

export function jobError(code: string): JobErrorInfo {
  const known = (ERRORS as Readonly<Record<string, (typeof ERRORS)[JobErrorCode] | undefined>>)[
    code
  ];
  return known ? { code, ...known } : { code, text: code, group: null };
}
