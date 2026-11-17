import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { recreateDatabaseFromMigrations } from '@acf/database/admin';

import { e2eDatabaseUrls, loadRootEnv, repoRoot } from './env';

/**
 * Builds the disposable E2E database from the committed migrations and seeds the demo
 * workspace with the real seed CLI. The credentials it prints once are handed to the tests
 * through the environment (inherited by Playwright workers).
 */
export default async function globalSetup(): Promise<void> {
  loadRootEnv();
  const urls = e2eDatabaseUrls();
  await recreateDatabaseFromMigrations(urls);
  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, 'apps/api/dist/cli/seed.js')],
    {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_MIGRATION_URL: urls.migratorUrl },
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
}
