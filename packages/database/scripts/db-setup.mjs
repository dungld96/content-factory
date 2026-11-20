#!/usr/bin/env node
// Local/CI database setup (ADR-0011 §8, decision U3). Never used in production.
//   bootstrap : create/update roles acf_migrator + acf_app, the database(s), and grants
//   setup     : bootstrap, then `prisma migrate deploy` as acf_migrator, then re-apply grants
// Reads DATABASE_ADMIN_URL, DATABASE_MIGRATION_URL, DATABASE_URL and optional
// DATABASE_SHADOW_URL from the shell or the repository-root .env. Never prints secrets.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { bootstrapDatabase, credentialsFromUrl } from '../dist/admin/index.js';

const packageDir = path.resolve(import.meta.dirname, '..');
try {
  process.loadEnvFile(path.resolve(packageDir, '../../.env'));
} catch {
  // No .env: rely on the process environment (CI).
}

const command = process.argv[2];
if (command !== 'bootstrap' && command !== 'setup') {
  console.error('usage: db-setup.mjs <bootstrap|setup>');
  process.exit(2);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set (see .env.example)`);
    process.exit(2);
  }
  return value;
}

const urls = {
  adminUrl: required('DATABASE_ADMIN_URL'),
  migratorUrl: required('DATABASE_MIGRATION_URL'),
  appUrl: required('DATABASE_URL'),
};
const shadowUrl = process.env['DATABASE_SHADOW_URL'];
const extraDatabases = shadowUrl
  ? [credentialsFromUrl('DATABASE_SHADOW_URL', shadowUrl).database]
  : [];

const { databases } = await bootstrapDatabase(urls, { extraDatabases });
console.info(`✔ roles and grants applied (databases: ${databases.join(', ')})`);

if (command === 'setup') {
  // Run the Prisma CLI's JS entry with the current Node binary rather than spawning
  // `pnpm`: on Windows pnpm is a .cmd shim that execFileSync cannot launch without a shell.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: packageDir,
    stdio: 'inherit',
  });
  // Re-apply grants: revokes the app role's default privileges on _prisma_migrations.
  await bootstrapDatabase(urls, { extraDatabases });
  console.info('✔ migrations applied and grants re-applied');
}
