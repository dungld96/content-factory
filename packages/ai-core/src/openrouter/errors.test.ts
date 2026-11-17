import { describe, expect, it } from 'vitest';

import { classifyOpenRouterError, errorStatus, parseRetryAfter } from './errors.js';

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);
  it.each<[string | null, number | undefined]>([
    [null, undefined],
    ['0', 0],
    ['60', 60_000],
    [' 5 ', 5_000],
    ['Tue, 17 Nov 2026 12:00:30 GMT', 30_000],
    ['Tue, 17 Nov 2026 11:00:00 GMT', 0],
    ['soon', undefined],
    ['-1', undefined],
  ])('%j → %j ms', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe('classifyOpenRouterError', () => {
  it('prefers a budget limit source over the error type', () => {
    expect(
      classifyOpenRouterError(403, {
        code: 403,
        metadata: { error_type: 'permission_denied', limit_source: 'openrouter_workspace_budget' },
      }).code,
    ).toBe('PROVIDER_BUDGET_EXCEEDED');
  });

  it('uses a fixed message for content policy (no echoed input)', () => {
    const result = classifyOpenRouterError(403, {
      message: 'Your input "secret brief" was flagged',
      metadata: { error_type: 'content_policy_violation' },
    });
    expect(result).toMatchObject({
      code: 'CONTENT_POLICY',
      message: 'content policy (content_policy_violation)',
    });
  });

  it('classifies by status without a body', () => {
    expect(classifyOpenRouterError(401, undefined).code).toBe('AUTHENTICATION');
    expect(classifyOpenRouterError(599, undefined).code).toBe('PROVIDER_ERROR');
  });
});

describe('errorStatus', () => {
  it('reads numeric and numeric-string codes only', () => {
    expect(errorStatus({ code: 502 })).toBe(502);
    expect(errorStatus({ code: '429' })).toBe(429);
    expect(errorStatus({ code: 'rate_limited' })).toBeUndefined();
    expect(errorStatus(undefined)).toBeUndefined();
  });
});
