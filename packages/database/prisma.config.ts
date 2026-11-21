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

const shadowDatabaseUrl = process.env['DATABASE_SHADOW_URL'];

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    // Migrations run as the schema-owner role (acf_migrator), never as the runtime role
    // (DATABASE_URL = acf_app, DML only). See ADR-0011 §8. Not required for `prisma generate`.
    url: process.env['DATABASE_MIGRATION_URL'] ?? '',
    // `prisma migrate dev` needs a shadow database; acf_migrator has no CREATEDB, so
    // `pnpm db:bootstrap` pre-creates it.
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
