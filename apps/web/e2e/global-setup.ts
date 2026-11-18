import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { recreateDatabaseFromMigrations } from '@acf/database/admin';
import { ensureBucket, storageAdminSettingsFromEnv } from '@acf/storage/admin';

import {
  E2E_BUCKET,
  E2E_READY_FILE,
  e2eDatabaseUrls,
  e2eStorageEnv,
  loadRootEnv,
  repoRoot,
} from './env';

/**
 * Builds the disposable E2E database from the committed migrations and seeds the demo
 * workspace with the real seed CLI. The credentials it prints once are handed to the tests
 * through the environment (inherited by Playwright workers).
 */
export default async function globalSetup(): Promise<void> {
  loadRootEnv();
  const urls = e2eDatabaseUrls();
  await recreateDatabaseFromMigrations(urls);
  if (process.env['S3_ENDPOINT']) {
    await ensureBucket(storageAdminSettingsFromEnv(process.env), E2E_BUCKET);
  }
  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, 'apps/api/dist/cli/seed.js')],
    {
      env: {
        ...process.env,
        ...e2eStorageEnv(),
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: urls.migratorUrl,
      },
      encoding: 'utf8',
    },
  );
  for (const match of output.matchAll(/^\s+(\w+)@demo\.acf\.test\s+(\S+)$/gm)) {
    const [, who, password] = match;
    if (who && password) process.env[`E2E_PASSWORD_${who.toUpperCase()}`] = password;
  }
  if (!process.env['E2E_PASSWORD_OWNER']) {
    throw new Error('the seed did not print demo credentials (was the E2E database not empty?)');
  }
  mkdirSync(path.dirname(E2E_READY_FILE), { recursive: true });
  writeFileSync(E2E_READY_FILE, new Date().toISOString());
}
