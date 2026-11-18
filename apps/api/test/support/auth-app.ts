import type { AddressInfo } from 'node:net';

import {
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import pg from 'pg';
import { inject } from 'vitest';

import { loadApiEnv, type ApiEnv } from '@acf/config';
import { createPrismaClient, type PrismaClient } from '@acf/database';

import type { ImageProvider, LlmProvider } from '@acf/ai-core';

import { IMAGE_PROVIDERS, LLM_PROVIDERS } from '../../src/ai/ai.tokens.js';
import { configureApp, createLogger } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';
import { Public } from '../../src/auth/public.decorator.js';
import { PasswordHasher } from '../../src/auth/password-hasher.js';
import {
  PrismaSessionStore,
  type SessionStoreEvent,
} from '../../src/auth/session/prisma-session-store.js';
import { SESSION_TOUCH_THROTTLE_MS } from '../../src/auth/auth.module.js';
import { API_ENV } from '../../src/config/api-config.module.js';
import { PrismaService } from '../../src/infrastructure/prisma.service.js';
import { UserAdminService } from '../../src/users/user-admin.service.js';
import { Gate } from './http-client.js';

declare module 'express-session' {
  interface SessionData {
    /** Test-only, non-persisted field: modifying it still triggers `store.set`. */
    scratch?: string;
  }
}

/** Gates by name, shared between the test and the test-only controller. */
export const gates = new Map<string, Gate>();
export function gate(name: string): Gate {
  const g = new Gate();
  gates.set(name, g);
  return g;
}
const wait = (name: string) => gates.get(name)?.arrive() ?? Promise.resolve();

/** Test-only routes that pause inside a request whose session is already loaded. */
@Controller('test-session')
class TestSessionController {
  /** Modifies a PERSISTED field, then waits (store.set runs after the gate opens). */
  @Post('modify/:gate')
  @HttpCode(200)
  async modify(@Req() req: Request, @Param('gate') name: string) {
    req.session.authenticatedAt = new Date().toISOString();
    await wait(name);
    return { ok: true };
  }

  /** Modifies a NON-persisted field, then waits. */
  @Post('modify-scratch/:gate')
  @HttpCode(200)
  async modifyScratch(@Req() req: Request, @Param('gate') name: string) {
    req.session.scratch = String(Date.now());
    await wait(name);
    return { ok: true };
  }

  /** Read-only request that waits (express-session then calls `touch`). */
  @Get('read/:gate')
  async read(@Param('gate') name: string) {
    await wait(name);
    return { ok: true };
  }

  /** A legitimate, immediate session modification. */
  @Post('reauth')
  @HttpCode(200)
  reauth(@Req() req: Request) {
    req.session.authenticatedAt = new Date(Date.now() + 1000).toISOString();
    return { authenticatedAt: req.session.authenticatedAt };
  }

  /** Breaks the design rule on purpose: a public handler writing to an anonymous session. */
  @Post('anon-write')
  @HttpCode(200)
  @Public()
  anonWrite(@Req() req: Request) {
    req.session.scratch = 'x';
    return { ok: true };
  }
}

@Module({ controllers: [TestSessionController] })
class TestSessionModule {}

export interface AuthTestApp {
  readonly app: INestApplication;
  readonly env: ApiEnv;
  readonly baseUrl: string;
  readonly events: SessionStoreEvent[];
  close(): Promise<void>;
}

export function authTestEnv(overrides: Record<string, string> = {}): ApiEnv {
  return loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: inject('apiDatabaseUrls').appUrl,
    REDIS_URL: 'redis://127.0.0.1:1',
    SESSION_SECRETS: 'test-session-secret-0123456789abcdef',
    CSRF_SECRET: 'test-csrf-secret-0123456789abcdef!!',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    ...testStorageEnv(),
    ...overrides,
  });
}

/** The real application (plus test-only routes) listening on an ephemeral port. */
export interface StartAuthAppOptions {
  /** Replaces the configured LLM adapters (e.g. with MockLlmProvider). */
  readonly llmProviders?: ReadonlyMap<string, LlmProvider>;
  /** Replaces the configured image adapters (e.g. with MockImageProvider, M4). */
  readonly imageProviders?: ReadonlyMap<string, ImageProvider>;
}

export async function startAuthApp(
  overrides: Record<string, string> = {},
  options: StartAuthAppOptions = {},
): Promise<AuthTestApp> {
  const env = authTestEnv(overrides);
  const events: SessionStoreEvent[] = [];
  let builder = Test.createTestingModule({
    imports: [AppModule.register(env), TestSessionModule],
  })
    .overrideProvider(PrismaSessionStore)
    .useFactory({
      inject: [PrismaService, API_ENV],
      factory: (prisma: PrismaService, e: ApiEnv) =>
        new PrismaSessionStore(prisma.client, {
          absoluteTtlMs: e.SESSION_ABSOLUTE_TTL_MS,
          idleTtlMs: e.SESSION_IDLE_TTL_MS,
          touchThrottleMs: SESSION_TOUCH_THROTTLE_MS,
          onEvent: (event) => events.push(event),
        }),
    });
  if (options.imageProviders) {
    builder = builder.overrideProvider(IMAGE_PROVIDERS).useValue(options.imageProviders);
  }
  if (options.llmProviders) {
    builder = builder.overrideProvider(LLM_PROVIDERS).useValue(options.llmProviders);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env, createLogger(env));
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
  return {
    app,
    env,
    baseUrl: `http://127.0.0.1:${port}`,
    events,
    close: () => app.close(),
  };
}

/** Migrator connection for cleanup (TRUNCATE) and direct inspection of the sessions table. */
export async function inspector(): Promise<pg.Client> {
  const db = new pg.Client({ connectionString: inject('apiDatabaseUrls').migratorUrl });
  await db.connect();
  return db;
}

export async function resetDatabase(db: pg.Client): Promise<void> {
  await db.query(`TRUNCATE users, sessions, projects, project_members, channels, characters,
    character_versions, character_version_assets, environments, environment_versions,
    environment_version_assets, assets, content_items, ai_providers, ai_models,
    ai_model_capabilities, ai_model_prices, ai_invocations, ai_usage_records, production_runs,
    generation_jobs, job_events, script_versions, storyboard_versions, storyboard_scenes,
    storyboard_scene_assets, ai_task_routes RESTART IDENTITY CASCADE`);
}

export function userAdmin(): { users: UserAdminService; prisma: PrismaClient } {
  const prisma = createPrismaClient({
    databaseUrl: inject('apiDatabaseUrls').appUrl,
    maxConnections: 2,
  });
  return { users: new UserAdminService(prisma, new PasswordHasher()), prisma };
}

export const PASSWORD = 'correct horse battery staple';

/** Object storage for API tests: the local/CI server with the dedicated `acf-test-api` bucket. */
export const API_TEST_BUCKET = 'acf-test-api';

function testStorageEnv(): Record<string, string> {
  const endpoint = process.env['S3_ENDPOINT'];
  const key = process.env['S3_ACCESS_KEY_ID'];
  const secret = process.env['S3_SECRET_ACCESS_KEY'];
  if (!endpoint || !key || !secret) return {};
  return {
    S3_ENDPOINT: endpoint,
    S3_BUCKET: API_TEST_BUCKET,
    S3_ACCESS_KEY_ID: key,
    S3_SECRET_ACCESS_KEY: secret,
  };
}
