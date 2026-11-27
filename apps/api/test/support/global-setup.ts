import path from 'node:path';

import type { TestProject } from 'vitest/node';

import { recreateDatabaseFromMigrations, withDatabase } from '@acf/database/admin';
import { ensureBucket, storageAdminSettingsFromEnv } from '@acf/storage/admin';

export const API_TEST_DATABASE = 'acf_test_api';

export interface ApiTestDatabaseUrls {
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly appUrl: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    apiDatabaseUrls: ApiTestDatabaseUrls;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (see .env.example and docs/LOCAL_DEVELOPMENT.md)`);
  return value;
}

/** Builds the disposable `acf_test_api` database from the committed migrations. */
export default async function setup(project: TestProject): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, '../../../../.env'));
  } catch {
    // CI: environment variables only.
  }
  const urls: ApiTestDatabaseUrls = {
    adminUrl: required('DATABASE_ADMIN_URL'),
    migratorUrl: withDatabase(required('DATABASE_MIGRATION_URL'), API_TEST_DATABASE),
    appUrl: withDatabase(required('DATABASE_URL'), API_TEST_DATABASE),
  };
  await recreateDatabaseFromMigrations(urls);
  // Asset bytes (M4a): the API test bucket, created with the storage admin key.
  if (process.env['S3_ENDPOINT']) {
    await ensureBucket(storageAdminSettingsFromEnv(process.env), 'acf-test-api');
  }
  project.provide('apiDatabaseUrls', urls);
}
