import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchApiHealth } from './api-health';

const ready = {
  status: 'ok',
  timestamp: '2026-01-01T00:00:00.000Z',
  checks: { database: { status: 'ok', latencyMs: 2 }, redis: { status: 'ok', latencyMs: 1 } },
};

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('fetchApiHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok for a healthy API', async () => {
    mockFetch(() => Promise.resolve(Response.json(ready)));
    await expect(fetchApiHealth()).resolves.toEqual({ kind: 'ok', data: ready });
  });

  it('returns degraded when a dependency is down (HTTP 503)', async () => {
    const degraded = {
      ...ready,
      status: 'error',
      checks: { ...ready.checks, redis: { status: 'error', latencyMs: 5, error: 'timeout' } },
    };
    mockFetch(() => Promise.resolve(Response.json(degraded, { status: 503 })));
    await expect(fetchApiHealth()).resolves.toMatchObject({ kind: 'degraded' });
  });

  it('returns unreachable on network failure', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(fetchApiHealth()).resolves.toEqual({
      kind: 'unreachable',
      reason: 'API is not reachable',
    });
  });

  it('returns unreachable when the payload does not match the contract', async () => {
    mockFetch(() => Promise.resolve(Response.json({ hello: 'world' })));
    await expect(fetchApiHealth()).resolves.toMatchObject({ kind: 'unreachable' });
  });
});
