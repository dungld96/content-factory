import { describe, expect, it } from 'vitest';

import { JOB_ERROR_CODES } from '@acf/contracts';

import type { MutationResult } from './api-client';
import { jobError } from './job-errors';
import { nextResumeStep } from './resume-flow';

const refused = (code: string, current?: unknown): MutationResult<unknown> => ({
  ok: false,
  status: 409,
  data: null,
  message: `refused: ${code}`,
  code,
  ...(current === undefined ? {} : { current }),
});

describe('job error catalogue (P3 W3)', () => {
  it('has a text and a group for every job error code', () => {
    for (const code of JOB_ERROR_CODES) {
      const info = jobError(code);
      expect(info.group, code).not.toBeNull();
      expect(info.text, code).not.toBe(code);
    }
  });

  it('maps the provider codes the worker records (not AUTH / INSUFFICIENT_CREDITS)', () => {
    expect(jobError('AUTHENTICATION').group).toBe('operator');
    expect(jobError('PROVIDER_BUDGET_EXCEEDED').group).toBe('operator');
  });

  it('marks unconfirmed paid calls as possibly charged', () => {
    expect(jobError('SUBMIT_OUTCOME_UNKNOWN').group).toBe('charged');
    expect(jobError('CALL_OUTCOME_UNKNOWN').group).toBe('charged');
  });

  it('falls back to the code for codes it does not know', () => {
    expect(jobError('SOMETHING_NEW')).toEqual({
      code: 'SOMETHING_NEW',
      text: 'SOMETHING_NEW',
      group: null,
    });
  });
});

describe('resume confirmations (P3 W1)', () => {
  const estimate = {
    totalEstimatedUsd: '1.2',
    scenes: [{ action: 'generate' }, { action: 'generate' }, { action: 'skip_has_clip' }],
  };

  it('confirms the clip estimate shown by the API', () => {
    const step = nextResumeStep(refused('ESTIMATE_CHANGED', estimate), {});
    expect(step.kind).toBe('confirm');
    if (step.kind !== 'confirm') return;
    expect(step.text).toContain('2 clips');
    expect(step.next).toEqual({ confirmedEstimateUsd: '1.2' });
  });

  it('confirms an unknown clip total together with the unknown cost', () => {
    const step = nextResumeStep(
      refused('ESTIMATE_CHANGED', { ...estimate, totalEstimatedUsd: null }),
      {},
    );
    expect(step.kind === 'confirm' && step.next).toEqual({
      confirmedEstimateUsd: null,
      acceptUnknownCost: true,
    });
  });

  it('does not confirm the estimate twice in one resume', () => {
    expect(
      nextResumeStep(refused('ESTIMATE_CHANGED', estimate), { confirmedEstimateUsd: '1.0' }).kind,
    ).toBe('error');
  });

  it('accepts unknown cost when asked, keeping earlier consents', () => {
    const step = nextResumeStep(refused('UNKNOWN_COST_NOT_ACCEPTED', {}), {
      confirmedEstimateUsd: '1.2',
    });
    expect(step.kind === 'confirm' && step.next).toEqual({
      confirmedEstimateUsd: '1.2',
      acceptUnknownCost: true,
    });
  });

  it('asks before a possible double charge, by skip reason (not message text)', () => {
    const step = nextResumeStep(
      refused('NOTHING_TO_RESUME', {
        skipped: [{ jobId: 'j', sceneId: null, reason: 'outcome_unknown' }],
      }),
      {},
    );
    expect(step.kind === 'confirm' && step.next).toEqual({ acceptPossibleDoubleCharge: true });
  });

  it('says nothing is left when every failure was redone or is running', () => {
    const step = nextResumeStep(
      refused('NOTHING_TO_RESUME', {
        skipped: [{ jobId: 'j', sceneId: null, reason: 'superseded' }],
      }),
      {},
    );
    expect(step.kind).toBe('error');
  });

  it('shows hard budget refusals and other errors as they are', () => {
    expect(nextResumeStep(refused('BUDGET_EXCEEDED'), {})).toEqual({
      kind: 'error',
      text: 'refused: BUDGET_EXCEEDED',
    });
  });
});

describe('job error catalogue in Vietnamese (R-D6)', () => {
  it('has a Vietnamese text for every job error code', () => {
    for (const code of JOB_ERROR_CODES) {
      const vi = jobError(code, 'vi').text;
      expect(vi, code).not.toBe(code);
      expect(vi, code).not.toBe(jobError(code).text);
    }
  });
});
