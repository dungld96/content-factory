import { describe, expect, it } from 'vitest';

import {
  isJobErrorCode,
  JOB_ERROR_CODES,
  OUTCOME_UNKNOWN_CODES,
  videoFailureCode,
} from './job-errors.js';

describe('job error codes (P3 W3, W5)', () => {
  it('lists each code once', () => {
    expect(new Set(JOB_ERROR_CODES).size).toBe(JOB_ERROR_CODES.length);
  });

  it('recognises listed codes only', () => {
    expect(isJobErrorCode('CALL_OUTCOME_UNKNOWN')).toBe(true);
    expect(isJobErrorCode('AUTH')).toBe(false);
  });

  it('maps terminal video statuses to their codes', () => {
    expect(videoFailureCode('failed')).toBe('PROVIDER_FAILED');
    expect(videoFailureCode('cancelled')).toBe('PROVIDER_CANCELLED');
    expect(videoFailureCode('expired')).toBe('PROVIDER_EXPIRED');
  });

  it('lists the unconfirmed-call codes among the job codes', () => {
    for (const code of OUTCOME_UNKNOWN_CODES) expect(isJobErrorCode(code)).toBe(true);
    expect([...OUTCOME_UNKNOWN_CODES].sort()).toEqual([
      'CALL_OUTCOME_UNKNOWN',
      'SUBMIT_OUTCOME_UNKNOWN',
    ]);
  });
});
