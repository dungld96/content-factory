import { describe, expect, it } from 'vitest';

import { apiErrorResponseSchema, readinessResponseSchema } from './index.js';

describe('contracts', () => {
  it('accepts a well-formed readiness payload', () => {
    const payload = {
      status: 'error',
      timestamp: new Date().toISOString(),
      checks: {
        database: { status: 'ok', latencyMs: 3 },
        redis: { status: 'error', latencyMs: 2000, error: 'timeout' },
      },
    };
    expect(readinessResponseSchema.parse(payload)).toEqual(payload);
  });

  it('rejects readiness payloads missing a check', () => {
    const result = readinessResponseSchema.safeParse({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: { database: { status: 'ok', latencyMs: 1 } },
    });
    expect(result.success).toBe(false);
  });

  it('describes the documented error envelope', () => {
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'x', retryable: false, correlationId: 'abc' },
      }).success,
    ).toBe(true);
  });
});
