import path from 'node:path';

import { ensureBucket, storageAdminSettingsFromEnv } from '../src/admin.js';

/** Bucket used by the storage compatibility tests (never the development bucket). */
export const TEST_BUCKET = 'acf-test-storage';

export default async function setup(): Promise<void> {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // CI: environment variables are set by the workflow.
  }
  await ensureBucket(storageAdminSettingsFromEnv(process.env), TEST_BUCKET);
}
