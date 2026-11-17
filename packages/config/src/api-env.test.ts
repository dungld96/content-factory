import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadApiEnv } from './index.js';

const valid = {
  DATABASE_URL: 'postgresql://acf:secret-password@localhost:5432/acf',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadApiEnv', () => {
  it('applies defaults for optional variables', () => {
    const env = loadApiEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      API_HOST: '0.0.0.0',
      API_PORT: 4000,
      API_CORS_ORIGINS: ['http://localhost:3000'],
      LOG_LEVEL: 'log',
      LOG_JSON: false,
      HEALTH_CHECK_TIMEOUT_MS: 2000,
    });
  });

  it('coerces and normalizes provided values', () => {
    const env = loadApiEnv({
      ...valid,
      NODE_ENV: 'production',
      API_PORT: '8080',
      API_CORS_ORIGINS: 'https://a.example.com, https://b.example.com',
      LOG_JSON: 'false',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.API_CORS_ORIGINS).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(env.LOG_JSON).toBe(false);
  });

  it('reports every missing required variable', () => {
    expect.assertions(2);
    try {
      loadApiEnv({});
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.map((i) => i.key).sort()).toEqual([
        'DATABASE_URL',
        'REDIS_URL',
      ]);
    }
  });

  it('rejects URLs with the wrong protocol', () => {
    expect(() => loadApiEnv({ ...valid, DATABASE_URL: 'mysql://u:p@localhost/db' })).toThrow(
      /DATABASE_URL: must be a valid URL using one of: postgres:, postgresql:/,
    );
    expect(() => loadApiEnv({ ...valid, REDIS_URL: 'http://localhost:6379' })).toThrow(/REDIS_URL/);
  });

  it('rejects out-of-range ports and invalid enums', () => {
    expect(() => loadApiEnv({ ...valid, API_PORT: '70000' })).toThrow(/API_PORT/);
    expect(() => loadApiEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadApiEnv({ ...valid, LOG_JSON: 'yes' })).toThrow(/LOG_JSON/);
  });

  it('never includes secret values in the error message', () => {
    const secret = 'super-secret-value-123';
    try {
      loadApiEnv({ DATABASE_URL: `mysql://user:${secret}@host/db`, REDIS_URL: secret });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify((error as EnvValidationError).issues)).not.toContain(secret);
    }
  });
});
