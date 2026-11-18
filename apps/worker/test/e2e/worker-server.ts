// E2E only (Playwright webServer): the production worker build with the fixture LLM as the
// `mock` provider. Prints `worker_started` (Playwright waits for it). Node type stripping.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadWorkerEnv } from '@acf/config';
import { createFixtureLlmProvider } from '@acf/content-domain/testing';

import type * as Main from '../../src/main.js';

const main = pathToFileURL(path.resolve(import.meta.dirname, '../../dist/main.js')).href;
const { startWorker } = (await import(main)) as typeof Main;

// Playwright starts web servers before global setup rebuilds the database: report readiness to
// Playwright now, then wait for global setup's marker before connecting (apps/web/e2e/env.ts).
const readyFile = process.env['E2E_READY_FILE'];
if (readyFile) {
  rmSync(readyFile, { force: true });
  console.info('e2e worker waiting for the database');
  const deadline = Date.now() + 120_000;
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline) throw new Error('E2E database was not ready in time');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const running = await startWorker(
  loadWorkerEnv(process.env),
  new Map([['mock', createFixtureLlmProvider('mock')]]),
);
const stop = () => {
  running.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
