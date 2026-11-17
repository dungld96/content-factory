import path from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

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
        },
      },
      {
        plugins: [nestSwc()],
        test: {
          name: 'unit:api',
          root: path.join(root, 'apps/api'),
          include: ['src/**/*.test.ts', 'test/**/*.e2e.test.ts'],
          environment: 'node',
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
        },
      },
      {
        plugins: [nestSwc()],
        test: {
          name: 'integration:api',
          root: path.join(root, 'apps/api'),
          include: ['test/**/*.integration.test.ts'],
          environment: 'node',
          setupFiles: [path.join(root, 'test-support/load-root-env.ts')],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
