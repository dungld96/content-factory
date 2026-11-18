import path from 'node:path';

import { withDatabase } from '@acf/database/admin';

/** Ports and names reserved for the E2E run (distinct from `pnpm dev`). */
export const E2E = {
  database: 'acf_test_e2e',
  apiPort: 4100,
  webPort: 3100,
} as const;

export const WEB_URL = `http://localhost:${E2E.webPort}`;
/** BullMQ key prefix shared by the E2E API and worker. */
export const E2E_QUEUE_PREFIX = 'acf-e2e';
export const API_URL = `http://127.0.0.1:${E2E.apiPort}`;

const repoRoot = path.resolve(import.meta.dirname, '../../..');
export { repoRoot };

/**
 * Written by global setup once the E2E database is rebuilt and seeded. Playwright starts web
 * servers before global setup, so the E2E worker waits for this file before connecting.
 */
export const E2E_READY_FILE = path.join(repoRoot, 'apps/web/test-results/.e2e-database-ready');

/** Loads the repository-root .env (if any) without overriding the shell, like the apps do. */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
  } catch {
    // CI: environment variables only.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

/** Connection URLs pointing at the disposable E2E database. */
export function e2eDatabaseUrls() {
  return {
    adminUrl: required('DATABASE_ADMIN_URL'),
    migratorUrl: withDatabase(required('DATABASE_MIGRATION_URL'), E2E.database),
    appUrl: withDatabase(required('DATABASE_URL'), E2E.database),
  };
}
