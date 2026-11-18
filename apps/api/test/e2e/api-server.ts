// E2E only (Playwright webServer): the production API build with a fixture LLM registered as
// the `mock` provider, so generation requests route to the seeded `mock/echo` model. The worker
// E2E entry uses the same fixture. Run with Node's built-in type stripping.
import 'reflect-metadata';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Test } from '@nestjs/testing';

import { loadApiEnv } from '@acf/config';
import { createFixtureLlmProvider } from '@acf/content-domain/testing';

import type * as Tokens from '../../src/ai/ai.tokens.js';
import type * as Factory from '../../src/app.factory.js';
import type * as AppModuleFile from '../../src/app.module.js';

const dist = (file: string) =>
  pathToFileURL(path.resolve(import.meta.dirname, '../../dist', file)).href;
const { AppModule } = (await import(dist('app.module.js'))) as typeof AppModuleFile;
const { configureApp, createLogger } = (await import(dist('app.factory.js'))) as typeof Factory;
const { LLM_PROVIDERS } = (await import(dist('ai/ai.tokens.js'))) as typeof Tokens;

const env = loadApiEnv(process.env);
const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
  .overrideProvider(LLM_PROVIDERS)
  .useValue(new Map([['mock', createFixtureLlmProvider('mock')]]))
  .compile();
const app = moduleRef.createNestApplication({ logger: false });
configureApp(app, env, createLogger(env));
await app.listen(env.API_PORT, env.API_HOST);
console.info(`e2e api listening on ${env.API_HOST}:${String(env.API_PORT)}`);
