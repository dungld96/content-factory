import path from 'node:path';

import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env files automatically. Load the repository-root .env
// (if present) without overriding variables already set by the shell/CI.
const rootEnvFile = path.resolve(import.meta.dirname, '../../.env');
try {
  process.loadEnvFile(rootEnvFile);
} catch {
  // No .env file: rely on the process environment (CI, containers).
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    // Not required for `prisma generate`; required for migrate/studio commands.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
