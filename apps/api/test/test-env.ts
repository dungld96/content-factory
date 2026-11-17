import { loadApiEnv, type ApiEnv } from '@acf/config';

/** Env for tests that never touch real infrastructure (connections are lazy). */
export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
    LOG_LEVEL: 'error',
    HEALTH_CHECK_TIMEOUT_MS: '200',
    ...overrides,
  });
}
