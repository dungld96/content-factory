import { describe, expect, it } from 'vitest';

import {
  isProviderError,
  PROVIDER_ERROR_POLICY,
  ProviderError,
  ProviderErrorCode,
  ProviderErrorOutcome,
  sanitizeProviderMessage,
} from './errors.js';

describe('provider error policy', () => {
  it.each([
    ProviderErrorCode.AUTHENTICATION,
    ProviderErrorCode.PERMISSION_DENIED,
    ProviderErrorCode.CONTENT_POLICY,
    ProviderErrorCode.PROVIDER_BUDGET_EXCEEDED,
    ProviderErrorCode.INVALID_REQUEST,
    ProviderErrorCode.CONTEXT_LENGTH_EXCEEDED,
    ProviderErrorCode.UNSUPPORTED_PARAMETER,
    ProviderErrorCode.MODEL_NOT_FOUND,
  ])('%s is never retried and never failed over (CLAUDE.md §7)', (code) => {
    expect(PROVIDER_ERROR_POLICY[code]).toEqual({ retryable: false, fallbackAllowed: false });
  });

  it.each([
    ProviderErrorCode.RATE_LIMITED,
    ProviderErrorCode.PROVIDER_UNAVAILABLE,
    ProviderErrorCode.TIMEOUT,
    ProviderErrorCode.NETWORK,
    ProviderErrorCode.EMPTY_OUTPUT,
    ProviderErrorCode.PROVIDER_ERROR,
  ])('%s is transient: retry and fallback allowed', (code) => {
    expect(PROVIDER_ERROR_POLICY[code]).toEqual({ retryable: true, fallbackAllowed: true });
  });

  it('a malformed response may be retried but is no reason to switch model', () => {
    expect(PROVIDER_ERROR_POLICY.MALFORMED_RESPONSE).toEqual({
      retryable: true,
      fallbackAllowed: false,
    });
  });

  it('covers every code', () => {
    expect(Object.keys(PROVIDER_ERROR_POLICY).sort()).toEqual(
      Object.values(ProviderErrorCode).sort(),
    );
  });
});

describe('ProviderError', () => {
  it('derives its flags from the policy and keeps the details', () => {
    const cause = new Error('socket hang up');
    const error = new ProviderError(ProviderErrorCode.RATE_LIMITED, 'Rate limit exceeded', {
      outcome: ProviderErrorOutcome.REJECTED,
      retryAfterMs: 60_000,
      httpStatus: 429,
      providerErrorType: 'rate_limit_exceeded',
      providerCode: 'rate_limited',
      providerRequestId: 'gen-1',
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(new Error('x'))).toBe(false);
    expect(error).toMatchObject({
      name: 'ProviderError',
      code: 'RATE_LIMITED',
      retryable: true,
      fallbackAllowed: true,
      outcome: 'rejected',
      retryAfterMs: 60_000,
      httpStatus: 429,
      providerErrorType: 'rate_limit_exceeded',
      providerCode: 'rate_limited',
      providerRequestId: 'gen-1',
      message: 'Rate limit exceeded',
    });
    expect(error.cause).toBe(cause);
  });

  it('sanitizes its message', () => {
    const error = new ProviderError(ProviderErrorCode.PROVIDER_ERROR, 'line1\nline2\u0007', {
      outcome: ProviderErrorOutcome.UNKNOWN,
    });
    expect(error.message).toBe('line1 line2');
  });
});

describe('sanitizeProviderMessage', () => {
  it('bounds the length', () => {
    const out = sanitizeProviderMessage('x'.repeat(2000));
    expect(out).toHaveLength(500);
    expect(out.endsWith('…')).toBe(true);
  });
});
