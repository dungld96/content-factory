// Creates the asset bucket (S3_BUCKET) with the storage admin key. Idempotent.
// Usage: pnpm storage:setup   (reads the repository-root .env when present)
import path from 'node:path';

import { ensureBucket, storageAdminSettingsFromEnv } from '../dist/admin.js';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // No .env: rely on the process environment (CI, containers).
}
const bucket = process.env['S3_BUCKET']?.trim();
if (!bucket) {
  console.error('S3_BUCKET is not set (see .env.example)');
  process.exit(1);
}
const created = await ensureBucket(storageAdminSettingsFromEnv(process.env), bucket);
console.info(created ? `✔ created bucket ${bucket}` : `✔ bucket ${bucket} already exists`);
