import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadApiEnv } from './index.js';

const SESSION_SECRET = 's'.repeat(32);
const valid = {
  DATABASE_URL: 'postgresql://acf:secret-password@localhost:5432/acf',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRETS: SESSION_SECRET,
  CSRF_SECRET: 'c'.repeat(32),
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
      DATABASE_POOL_MAX: 10,
      DATABASE_POOL_TIMEOUT_MS: 10_000,
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
        'CSRF_SECRET',
        'DATABASE_URL',
        'REDIS_URL',
        'SESSION_SECRETS',
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

  it('validates database pool settings', () => {
    const env = loadApiEnv({ ...valid, DATABASE_POOL_MAX: '4', DATABASE_POOL_TIMEOUT_MS: '2500' });
    expect(env.DATABASE_POOL_MAX).toBe(4);
    expect(env.DATABASE_POOL_TIMEOUT_MS).toBe(2500);
    expect(() => loadApiEnv({ ...valid, DATABASE_POOL_MAX: '0' })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => loadApiEnv({ ...valid, DATABASE_POOL_TIMEOUT_MS: '10' })).toThrow(
      /DATABASE_POOL_TIMEOUT_MS/,
    );
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

  describe('authentication settings', () => {
    it('applies the session defaults outside production', () => {
      const env = loadApiEnv(valid);
      expect(env).toMatchObject({
        SESSION_SECRETS: [SESSION_SECRET],
        SESSION_COOKIE_SECURE: false,
        SESSION_IDLE_TTL_MS: 86_400_000,
        SESSION_ABSOLUTE_TTL_MS: 604_800_000,
        TRUST_PROXY: ['loopback'],
        WEB_ORIGINS: ['http://localhost:3000'],
        LOGIN_RATE_LIMIT_PER_MINUTE: 10,
        OPENAPI_PUBLIC: true,
      });
    });

    it('secures cookies and hides OpenAPI by default in production', () => {
      const env = loadApiEnv({ ...valid, NODE_ENV: 'production' });
      expect(env.SESSION_COOKIE_SECURE).toBe(true);
      expect(env.OPENAPI_PUBLIC).toBe(false);
    });

    it('parses secret rotation lists and TRUST_PROXY forms', () => {
      const env = loadApiEnv({
        ...valid,
        SESSION_SECRETS: `${'a'.repeat(32)}, ${'b'.repeat(40)}`,
        TRUST_PROXY: '10.0.0.0/8, loopback',
      });
      expect(env.SESSION_SECRETS).toEqual(['a'.repeat(32), 'b'.repeat(40)]);
      expect(env.TRUST_PROXY).toEqual(['10.0.0.0/8', 'loopback']);
      expect(loadApiEnv({ ...valid, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    });

    it.each([
      [{ SESSION_SECRETS: 'short' }, /SESSION_SECRETS/],
      [{ CSRF_SECRET: 'short' }, /CSRF_SECRET/],
      [{ CSRF_SECRET: SESSION_SECRET }, /CSRF_SECRET: must differ/],
      [
        { SESSION_IDLE_TTL_MS: '600000', SESSION_ABSOLUTE_TTL_MS: '60000' },
        /SESSION_ABSOLUTE_TTL_MS/,
      ],
      [{ WEB_ORIGINS: 'not a url' }, /WEB_ORIGINS/],
      [
        { NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' },
        /SESSION_COOKIE_SECURE: must be true/,
      ],
      [{ NODE_ENV: 'production', TRUST_PROXY: 'true' }, /TRUST_PROXY/],
      [{ NODE_ENV: 'production', TRUST_PROXY: '*' }, /TRUST_PROXY/],
    ])('rejects %o', (overrides, message) => {
      expect(() => loadApiEnv({ ...valid, ...overrides })).toThrow(message);
    });

    it('never echoes secret values in errors', () => {
      expect(() => loadApiEnv({ ...valid, SESSION_SECRETS: 'hunter2-too-short' })).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('hunter2') as string,
        }) as Error,
      );
    });
  });

  describe('AI providers (M2)', () => {
    const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

    it('leaves OpenRouter unconfigured by default, with safe defaults', () => {
      const env = loadApiEnv({ ...valid, OPENROUTER_API_KEY: '' });
      expect(env).toMatchObject({
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_TIMEOUT_MS: 120_000,
        OPENROUTER_APP_ATTRIBUTION: false,
      });
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
    });

    it('accepts a well-formed key and a local test base URL outside production', () => {
      const env = loadApiEnv({
        ...valid,
        OPENROUTER_API_KEY: ` ${KEY} `,
        OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/api/v1',
        OPENROUTER_TIMEOUT_MS: '5000',
      });
      expect(env.OPENROUTER_API_KEY).toBe(KEY);
      expect(env.OPENROUTER_TIMEOUT_MS).toBe(5000);
    });

    it.each([
      [
        'a key of another provider',
        { OPENROUTER_API_KEY: 'sk-ant-0123456789abcdef0123' },
        'OPENROUTER_API_KEY',
      ],
      ['a short key', { OPENROUTER_API_KEY: 'sk-or-v1-short' }, 'OPENROUTER_API_KEY'],
      ['a timeout below 1 s', { OPENROUTER_TIMEOUT_MS: '10' }, 'OPENROUTER_TIMEOUT_MS'],
      [
        'attribution without URL and title',
        { OPENROUTER_APP_ATTRIBUTION: 'true' },
        'OPENROUTER_APP_URL',
      ],
      [
        'http base URL in production',
        {
          NODE_ENV: 'production',
          SESSION_COOKIE_SECURE: 'true',
          OPENROUTER_BASE_URL: 'http://openrouter.example/api/v1',
        },
        'OPENROUTER_BASE_URL',
      ],
    ])('rejects %s', (_name, overrides, variable) => {
      expect(() => loadApiEnv({ ...valid, ...overrides })).toThrow(
        expect.objectContaining({ message: expect.stringContaining(variable) as string }) as Error,
      );
    });

    it('never echoes the key in errors', () => {
      const bad = 'sk-or-v1-has spaces and secrets';
      expect(() => loadApiEnv({ ...valid, OPENROUTER_API_KEY: bad })).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('secrets') as string,
        }) as Error,
      );
    });
  });
});

describe('storage variables (M4a)', () => {
  const storage = {
    S3_ENDPOINT: 'http://127.0.0.1:8333',
    S3_BUCKET: 'acf-assets',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('treats storage as optional, as a group', () => {
    expect(loadApiEnv(valid).S3_ENDPOINT).toBeUndefined();
    expect(loadApiEnv({ ...valid, ...storage })).toMatchObject({
      ...storage,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
      UPLOAD_MAX_IMAGE_BYTES: 25 * 1024 * 1024,
    });
  });

  it('requires the whole group once one variable is set', () => {
    expect(() => loadApiEnv({ ...valid, S3_ENDPOINT: storage.S3_ENDPOINT })).toThrow(
      EnvValidationError,
    );
  });
});
