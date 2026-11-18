import { defineConfig, devices } from '@playwright/test';

import {
  API_URL,
  E2E,
  E2E_QUEUE_PREFIX,
  E2E_READY_FILE,
  e2eDatabaseUrls,
  loadRootEnv,
  repoRoot,
  WEB_URL,
} from './e2e/env';

// Requires `pnpm build` (API, worker and web production builds), PostgreSQL, Redis and the
// database roles (`pnpm db:setup`). Run with `pnpm test:e2e`. The API and worker run their
// production builds through E2E entries that register a fixture LLM (no network, no cost).
loadRootEnv();
const urls = e2eDatabaseUrls();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: WEB_URL,
    trace: 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      name: 'api',
      command: 'node --enable-source-maps test/e2e/api-server.ts',
      cwd: `${repoRoot}/apps/api`,
      url: `${API_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        API_HOST: '127.0.0.1',
        API_PORT: String(E2E.apiPort),
        DATABASE_URL: urls.appUrl,
        REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
        SESSION_SECRETS: 'e2e-session-secret-not-for-production-01',
        CSRF_SECRET: 'e2e-csrf-secret-not-for-production-000001',
        SESSION_COOKIE_SECURE: 'false',
        TRUST_PROXY: 'loopback',
        WEB_ORIGINS: WEB_URL,
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
      },
    },
    {
      name: 'worker',
      command: 'node --enable-source-maps test/e2e/worker-server.ts',
      cwd: `${repoRoot}/apps/worker`,
      wait: { stdout: /e2e worker waiting for the database/ },
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        LOG_JSON: 'true',
        DATABASE_URL: urls.appUrl,
        REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
        WORKER_RECONCILE_INTERVAL_MS: '5000',
        E2E_READY_FILE,
      },
    },
    {
      name: 'web',
      command: `pnpm exec next start --port ${E2E.webPort}`,
      cwd: `${repoRoot}/apps/web`,
      url: `${WEB_URL}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NODE_ENV: 'production', API_INTERNAL_URL: API_URL },
    },
  ],
});
