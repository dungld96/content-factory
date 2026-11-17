import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CORRELATION_ID_HEADER,
  apiErrorResponseSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@acf/contracts';

import { configureApp, createLogger } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { READINESS_PROBES, type ReadinessProbes } from '../src/health/readiness-probe.js';

import { testEnv } from './test-env.js';

function http(app: INestApplication) {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

async function buildApp(probes: ReadinessProbes): Promise<INestApplication> {
  const env = testEnv();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(READINESS_PROBES)
    .useValue(probes)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env, createLogger(env));
  await app.init();
  return app;
}

const ok = () => Promise.resolve();
const fail = () =>
  Promise.reject(
    Object.assign(new Error('connect ECONNREFUSED user:pw@db'), { code: 'ECONNREFUSED' }),
  );

describe('Health endpoints (HTTP, mocked dependencies)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /api/v1/health returns liveness without touching dependencies', async () => {
    let called = false;
    const spy = () => {
      called = true;
      return Promise.resolve();
    };
    app = await buildApp({ database: spy, redis: spy });

    const res = await http(app).get('/api/v1/health').expect(200);

    expect(livenessResponseSchema.parse(res.body).status).toBe('ok');
    expect(called).toBe(false);
  });

  it('GET /api/v1/health/ready returns 200 when all dependencies are up', async () => {
    app = await buildApp({ database: ok, redis: ok });

    const res = await http(app).get('/api/v1/health/ready').expect(200);

    const body = readinessResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/health/ready returns 503 with sanitized errors when a dependency is down', async () => {
    app = await buildApp({ database: fail, redis: ok });

    const res = await http(app).get('/api/v1/health/ready').expect(503);

    const body = readinessResponseSchema.parse(res.body);
    expect(body.status).toBe('error');
    expect(body.checks.database).toMatchObject({ status: 'error', error: 'unreachable' });
    expect(body.checks.redis.status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toContain('pw');
  });

  it('reports a timeout when a dependency hangs', async () => {
    app = await buildApp({ database: ok, redis: () => new Promise<void>(() => undefined) });

    const res = await http(app).get('/api/v1/health/ready').expect(503);

    expect(res.body.checks.redis).toMatchObject({ status: 'error', error: 'timeout' });
  });

  it('echoes a safe caller correlation ID and generates one otherwise', async () => {
    app = await buildApp({ database: ok, redis: ok });

    const supplied = 'client-request-12345';
    const echoed = await http(app).get('/api/v1/health').set(CORRELATION_ID_HEADER, supplied);
    expect(echoed.headers[CORRELATION_ID_HEADER]).toBe(supplied);

    const unsafe = await http(app)
      .get('/api/v1/health')
      .set(CORRELATION_ID_HEADER, 'bad id; <script>alert(1)</script>');
    expect(unsafe.headers[CORRELATION_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the documented error envelope for unknown routes', async () => {
    app = await buildApp({ database: ok, redis: ok });

    const res = await http(app).get('/api/v1/does-not-exist').expect(404);

    const body = apiErrorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.retryable).toBe(false);
    expect(body.error.correlationId).toBe(res.headers[CORRELATION_ID_HEADER]);
  });

  it('serves nothing outside the versioned prefix', async () => {
    app = await buildApp({ database: ok, redis: ok });
    await http(app).get('/health').expect(404);
  });
});
