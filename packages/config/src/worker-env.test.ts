import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadWorkerEnv } from './index.js';

const valid = {
  DATABASE_URL: 'postgresql://acf_app:pw@localhost:5432/acf',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadWorkerEnv', () => {
  it('applies defaults', () => {
    expect(loadWorkerEnv(valid)).toMatchObject({
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 2,
      WORKER_RECONCILE_INTERVAL_MS: 60_000,
      QUEUE_PREFIX: 'acf',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      LOG_JSON: true,
    });
  });

  it.each([
    [{ WORKER_CONCURRENCY: '0' }, 'WORKER_CONCURRENCY'],
    [{ QUEUE_PREFIX: 'Bad Prefix' }, 'QUEUE_PREFIX'],
    [{ REDIS_URL: 'http://x' }, 'REDIS_URL'],
    [{ OPENROUTER_API_KEY: 'nope' }, 'OPENROUTER_API_KEY'],
    [{ NODE_ENV: 'production', OPENROUTER_BASE_URL: 'http://x.test/api' }, 'OPENROUTER_BASE_URL'],
  ])('rejects %o', (overrides, variable) => {
    expect(() => loadWorkerEnv({ ...valid, ...overrides })).toThrow(EnvValidationError);
    expect(() => loadWorkerEnv({ ...valid, ...overrides })).toThrow(variable);
  });
});
