import { describe, expect, it } from 'vitest';

import {
  DOUBLE_CHARGE_CODES,
  FINISHABLE_CODES,
  isFinishable,
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

  it('finishes only delivered media jobs that failed for an environmental reason (P3d R3)', () => {
    for (const code of [...FINISHABLE_CODES, ...DOUBLE_CHARGE_CODES])
      expect(isJobErrorCode(code)).toBe(true);
    const job = {
      kind: 'video_generation',
      status: 'failed',
      errorCode: 'MEDIA_TOOLS_MISSING',
      deliveredAt: new Date(),
    };
    expect(isFinishable(job)).toBe(true);
    expect(isFinishable({ ...job, deliveredAt: null })).toBe(false);
    expect(isFinishable({ ...job, errorCode: 'OUTPUT_INVALID' })).toBe(false);
    expect(isFinishable({ ...job, kind: 'image_generation' })).toBe(false);
    expect(isFinishable({ ...job, status: 'canceled' })).toBe(false);
    expect(DOUBLE_CHARGE_CODES.has('OUTPUT_NOT_STORED')).toBe(true);
  });
});
