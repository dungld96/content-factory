import path from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;
const networkGuard = path.join(root, 'test-support/network-guard.ts');

// NestJS relies on decorator metadata, which esbuild/oxc do not emit. SWC does.
const nestSwc = () =>
  swc.vite({
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      target: 'es2023',
    },
    module: { type: 'es6' },
  });

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/generated/**', 'apps/api/src/main.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit:packages',
          root,
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
          setupFiles: [networkGuard],
        },
      },
      {
        plugins: [nestSwc()],
        test: {
          name: 'unit:api',
          root: path.join(root, 'apps/api'),
          include: ['src/**/*.test.ts', 'test/**/*.e2e.test.ts'],
          environment: 'node',
          setupFiles: [networkGuard],
        },
      },
      {
        resolve: {
          alias: {
            'server-only': path.join(root, 'test-support/server-only.ts'),
            '@': path.join(root, 'apps/web/src'),
          },
        },
        test: {
          name: 'unit:web',
          root: path.join(root, 'apps/web'),
          include: ['src/**/*.test.ts'],
          environment: 'node',
          setupFiles: [networkGuard],
        },
      },
      {
        test: {
          // Deployment scripts (M8.5 Q9), run with stub `gcloud`/`crontab`/`docker` on PATH.
          name: 'unit:infra',
          root: path.join(root, 'infra'),
          include: ['**/*.test.ts'],
          environment: 'node',
          setupFiles: [networkGuard],
        },
      },
      {
        test: {
          name: 'integration:database',
          root: path.join(root, 'packages/database'),
          include: ['test/**/*.integration.test.ts'],
          environment: 'node',
          setupFiles: [networkGuard],
          // Builds the disposable `acf_test` database from the committed migrations.
          globalSetup: [path.join(root, 'packages/database/test/global-setup.ts')],
          // Files share one database and TRUNCATE it: run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'integration:storage',
          root: path.join(root, 'packages/storage'),
          include: ['test/**/*.integration.test.ts'],
          environment: 'node',
          setupFiles: [path.join(root, 'test-support/load-root-env.ts'), networkGuard],
          // Creates the disposable `acf-test-storage` bucket with the storage admin key.
          globalSetup: [path.join(root, 'packages/storage/test/global-setup.ts')],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        plugins: [nestSwc()],
        test: {
          name: 'integration:api',
          root: path.join(root, 'apps/api'),
          include: ['test/**/*.integration.test.ts'],
          environment: 'node',
          setupFiles: [path.join(root, 'test-support/load-root-env.ts'), networkGuard],
          // Builds the disposable `acf_test_api` database from the committed migrations.
          globalSetup: [path.join(root, 'apps/api/test/support/global-setup.ts')],
          // Files share that database and TRUNCATE it: run them one at a time.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration:worker',
          root: path.join(root, 'apps/worker'),
          include: ['test/**/*.integration.test.ts'],
          environment: 'node',
          setupFiles: [path.join(root, 'test-support/load-root-env.ts'), networkGuard],
          // Builds the disposable `acf_test_worker` database from the committed migrations.
          globalSetup: [path.join(root, 'apps/worker/test/support/global-setup.ts')],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
