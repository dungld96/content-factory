import {
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiErrorResponseSchema, paginationQuerySchema } from '@acf/contracts';

import { configureApp, createLogger } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { IfMatch } from '../src/common/http/etag.js';
import { Endpoint, ValidBody, ValidParams, ValidQuery } from '../src/common/http/endpoint.js';
import { OpenApiService } from '../src/openapi/openapi.service.js';

import { testEnv } from './test-env.js';

const widgetSchema = z.strictObject({ name: z.string().min(1).max(10), size: z.number().int() });
const idParams = z.strictObject({ widgetId: z.uuid() });

/** Test-only routes exercising the request-validation and precondition plumbing. */
@Controller('test-widgets')
class WidgetController {
  @Post(':widgetId')
  @HttpCode(200)
  @Endpoint({
    summary: 'Echo a validated widget',
    params: idParams,
    query: paginationQuerySchema,
    body: widgetSchema,
    headers: ['If-Match'],
    responses: { 200: { description: 'Echo', schema: z.unknown() } },
    errors: [400, 412, 428],
  })
  echo(
    @ValidParams() params: unknown,
    @ValidQuery() query: unknown,
    @ValidBody() body: unknown,
    @IfMatch() expected: Date | undefined,
  ) {
    return { params, query, body, expected: expected?.toISOString() ?? null };
  }

  @Get('undocumented/:id')
  undocumented(@Param('id') id: string) {
    return { id };
  }
}

@Module({ controllers: [WidgetController] })
class WidgetModule {}

async function build(overrides: Record<string, string> = {}, extra: unknown[] = []) {
  const env = testEnv(overrides);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env), ...(extra as [])],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env, createLogger(env));
  await app.init();
  return app;
}

const http = (app: INestApplication) =>
  request(app.getHttpServer() as Parameters<typeof request>[0]);

const ID = '0190a0b0-0000-7000-8000-000000000001';

describe('API foundation', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('request validation', () => {
    it('passes parsed, coerced input to the handler', async () => {
      app = await build({}, [WidgetModule]);
      const res = await http(app)
        .post(`/api/v1/test-widgets/${ID}?limit=5`)
        .set('If-Match', 'W/"1700000000000"')
        .send({ name: 'a', size: 3 })
        .expect(200);
      expect(res.body).toEqual({
        params: { widgetId: ID },
        query: { limit: 5 },
        body: { name: 'a', size: 3 },
        expected: new Date(1_700_000_000_000).toISOString(),
      });
    });

    it('rejects invalid params, query and body with VALIDATION_FAILED details', async () => {
      app = await build({}, [WidgetModule]);
      const res = await http(app)
        .post('/api/v1/test-widgets/not-a-uuid?limit=0')
        .send({ name: '', size: 1.5, extra: true })
        .expect(400);
      const body = apiErrorResponseSchema.parse(res.body);
      expect(body.error.code).toBe('VALIDATION_FAILED');
      // Every declared part is validated in one pass.
      expect(body.error.details?.map((d) => d.path).sort()).toEqual(
        ['body', 'body.name', 'body.size', 'params.widgetId', 'query.limit'].sort(),
      );
    });

    it('rejects a malformed If-Match with 412 and a missing one with 428 when required', async () => {
      app = await build({}, [WidgetModule]);
      await http(app)
        .post(`/api/v1/test-widgets/${ID}`)
        .set('If-Match', '*')
        .send({ name: 'a', size: 1 })
        .expect(412);
      await app.close();

      app = await build({ REQUIRE_IF_MATCH: 'true' }, [WidgetModule]);
      const res = await http(app)
        .post(`/api/v1/test-widgets/${ID}`)
        .send({ name: 'a', size: 1 })
        .expect(428);
      expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
    });
  });

  describe('OpenAPI', () => {
    it('documents every registered application route', async () => {
      app = await build();
      const routes = app.get(OpenApiService).routes();
      expect(routes.length).toBeGreaterThan(0);
      expect(routes.filter((r) => !r.spec).map((r) => r.handler)).toEqual([]);
    });

    it('detects a route without @Endpoint metadata', async () => {
      app = await build({}, [WidgetModule]);
      const missing = app
        .get(OpenApiService)
        .routes()
        .filter((r) => !r.spec)
        .map((r) => `${r.method} ${r.path}`);
      expect(missing).toEqual(['get /test-widgets/undocumented/:id']);
    });

    it('serves an OpenAPI 3.1 document with every route', async () => {
      app = await build();
      const res = await http(app).get('/api/v1/openapi.json').expect(200);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.servers).toEqual([{ url: '/api/v1' }]);
      const operations = Object.entries(res.body.paths as Record<string, object>).flatMap(
        ([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`),
      );
      const expected = app
        .get(OpenApiService)
        .routes()
        .map((r) => `${r.method} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
      expect(operations.sort()).toEqual(expected.sort());
    });

    it('renders params, query, headers, body and error responses', async () => {
      app = await build({}, [WidgetModule]);
      const doc = app.get(OpenApiService).document();
      const op = doc.paths?.['/test-widgets/{widgetId}']?.post;
      expect(op?.parameters?.map((p) => ('name' in p ? `${p.in}:${p.name}` : '$ref'))).toEqual(
        expect.arrayContaining(['path:widgetId', 'query:limit', 'query:cursor', 'header:If-Match']),
      );
      expect(op?.requestBody).toBeDefined();
      expect(Object.keys(op?.responses ?? {})).toEqual(['200', '400', '412', '428']);
    });

    it('hides the document when OPENAPI_PUBLIC=false', async () => {
      app = await build({ OPENAPI_PUBLIC: 'false' });
      await http(app).get('/api/v1/openapi.json').expect(404);
    });
  });

  it('sets security headers (helmet) and no x-powered-by', async () => {
    app = await build();
    const res = await http(app).get('/api/v1/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
