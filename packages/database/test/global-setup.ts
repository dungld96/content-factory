import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { TestProject } from 'vitest/node';

import { bootstrapDatabase, dropDatabase, withDatabase } from '../src/admin/index.js';
import { TEST_DATABASE_NAME, type TestDatabaseUrls } from './support/urls.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
  }
}

const packageDir = path.resolve(import.meta.dirname, '..');

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Database integration tests need DATABASE_ADMIN_URL, ` +
        'DATABASE_MIGRATION_URL and DATABASE_URL (see .env.example and docs/LOCAL_DEVELOPMENT.md).',
    );
  }
  return value;
}

/**
 * Builds a disposable test database `acf_test` from the committed migrations, exactly as
 * production would: roles and grants via the bootstrap, then `prisma migrate deploy` as the
 * migrator role. Tests then connect as the DML-only app role (ADR-0011 §8).
 */
export default async function setup(project: TestProject): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(packageDir, '../../.env'));
  } catch {
    // No .env present: rely on the process environment (CI).
  }
  const urls: TestDatabaseUrls = {
    adminUrl: required('DATABASE_ADMIN_URL'),
    migratorUrl: withDatabase(required('DATABASE_MIGRATION_URL'), TEST_DATABASE_NAME),
    appUrl: withDatabase(required('DATABASE_URL'), TEST_DATABASE_NAME),
  };

  await dropDatabase(urls.adminUrl, TEST_DATABASE_NAME);
  await bootstrapDatabase(urls);
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_MIGRATION_URL: urls.migratorUrl },
    stdio: 'pipe',
  });
  await bootstrapDatabase(urls); // re-apply grants after _prisma_migrations exists

  project.provide('databaseUrls', urls);
}
