// E2E only (Playwright webServer): the production worker build with the fixture LLM as the
// `mock` provider. Prints `worker_started` (Playwright waits for it). Node type stripping.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MockImageProvider, MockTtsProvider, MockVideoProvider } from '@acf/ai-core/testing';
import { loadWorkerEnv } from '@acf/config';
import { createFixtureLlmProvider } from '@acf/content-domain/testing';

import type * as Main from '../../src/main.js';
import type * as MockMedia from '../../src/mock-media.js';

const dist = (file: string) =>
  pathToFileURL(path.resolve(import.meta.dirname, '../../dist', file)).href;
const { startWorker } = (await import(dist('main.js'))) as typeof Main;
const { audioRenderer, clipRenderer } = (await import(dist('mock-media.js'))) as typeof MockMedia;

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

const running = await startWorker(loadWorkerEnv(process.env), {
  llm: new Map([['mock', createFixtureLlmProvider('mock')]]),
  images: new Map([['mock', new MockImageProvider({ providerKey: 'mock' })]]),
  // Real MP4/MP3 files (FFmpeg) so the browser plays them; clips finish after two polls.
  videos: new Map([
    ['mock', new MockVideoProvider({ providerKey: 'mock', renderClip: clipRenderer() })],
  ]),
  tts: new Map([
    ['mock', new MockTtsProvider({ providerKey: 'mock', renderAudio: audioRenderer() })],
  ]),
});
const stop = () => {
  running.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
