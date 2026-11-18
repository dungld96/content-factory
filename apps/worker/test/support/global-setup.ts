import path from 'node:path';

import type { TestProject } from 'vitest/node';

import { recreateDatabaseFromMigrations, withDatabase } from '@acf/database/admin';

export const WORKER_TEST_DATABASE = 'acf_test_worker';

export interface WorkerTestDatabaseUrls {
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly appUrl: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    workerDatabaseUrls: WorkerTestDatabaseUrls;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (see .env.example and docs/LOCAL_DEVELOPMENT.md)`);
  return value;
}

/** Builds the disposable `acf_test_worker` database from the committed migrations. */
export default async function setup(project: TestProject): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, '../../../../.env'));
  } catch {
    // CI: environment variables only.
  }
  const urls: WorkerTestDatabaseUrls = {
    adminUrl: required('DATABASE_ADMIN_URL'),
    migratorUrl: withDatabase(required('DATABASE_MIGRATION_URL'), WORKER_TEST_DATABASE),
    appUrl: withDatabase(required('DATABASE_URL'), WORKER_TEST_DATABASE),
  };
  await recreateDatabaseFromMigrations(urls);
  project.provide('workerDatabaseUrls', urls);
}
