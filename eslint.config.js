// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Note: `eslint-config-next` is not used because its bundled plugins (react, jsx-a11y,
// import) do not yet declare ESLint 10 support. See docs/adr/0007-toolchain-and-module-system.md.
export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/generated/**',
      'apps/web/next-env.d.ts',
      // Design-verification scripts (reference only; not part of the build).
      'docs/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // NestJS DI needs runtime class references in constructor parameters
    // (emitDecoratorMetadata), so `import type` would silently break injection.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      // Nest declares option bags (e.g. NestApplicationContextOptions) as classes but expects
      // plain object literals, which this rule reports as false positives.
      '@typescript-eslint/no-unsafe-class-instance-assignment': 'off',
    },
  },
  {
    // Business code sees only provider-agnostic interfaces (ADR-0004; M2 package §3.1, P6):
    // vendor adapters are wired in one ai-runtime module, and test doubles stay in tests.
    files: ['**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.ts',
      'apps/api/test/**',
      'apps/worker/test/**',
      'test-support/**',
      'packages/ai-runtime/src/providers/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@acf/ai-core/*'],
              message:
                'Import provider-agnostic types from `@acf/ai-core`. Vendor adapters are wired only in packages/ai-runtime/src/providers; test doubles only in tests.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ai-runtime/src/providers/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@acf/ai-core/*', '!@acf/ai-core/openrouter'],
              message: 'Only the OpenRouter adapter subpath may be imported here.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'apps/api/test/**/*.ts'],
    rules: {
      // supertest bodies are `any`; tests assert on them via contract schemas.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
