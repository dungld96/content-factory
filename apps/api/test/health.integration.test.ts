import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '@acf/config';
import { readinessResponseSchema } from '@acf/contracts';

import { createApp } from '../src/app.factory.js';

function http(app: INestApplication) {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

/**
 * Requires running PostgreSQL and Redis (`pnpm infra:up`) and DATABASE_URL / REDIS_URL
 * in the environment or repository-root .env. Run with `pnpm test:integration`.
 */
describe('Readiness against real PostgreSQL and Redis', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const env = loadApiEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error' });
    app = await createApp(env);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports both dependencies healthy', async () => {
    const res = await http(app).get('/api/v1/health/ready');
    const body = readinessResponseSchema.parse(res.body);
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
    expect(res.status).toBe(200);
  });
});

describe('Readiness with unreachable dependencies', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const env = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgresql://nobody:nopass@127.0.0.1:1/none',
      REDIS_URL: 'redis://127.0.0.1:1',
      HEALTH_CHECK_TIMEOUT_MS: '500',
      SESSION_SECRETS: 'test-session-secret-0123456789abcdef',
      CSRF_SECRET: 'test-csrf-secret-0123456789abcdef!!',
    });
    app = await createApp(env);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 and does not leak connection details', async () => {
    const res = await http(app).get('/api/v1/health/ready').expect(503);
    expect(res.body.checks.database.status).toBe('error');
    expect(res.body.checks.redis.status).toBe('error');
    expect(JSON.stringify(res.body)).not.toContain('nopass');
  });
});
