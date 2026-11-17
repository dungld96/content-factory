// `pnpm db:seed` (development-only demo workspace; owner decision at the M1 review).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createPrismaClient, type PrismaClient } from '@acf/database';

import { DEMO_DOMAIN, seedDemoWorkspace } from '../src/cli/seed.js';
import { resetDatabase } from './support/auth-app.js';

let prisma: PrismaClient;
let db: pg.Client;

beforeAll(async () => {
  db = new pg.Client({ connectionString: inject('apiDatabaseUrls').migratorUrl });
  await db.connect();
  await resetDatabase(db);
  // The seed runs as the migrator role (decision U3).
  prisma = createPrismaClient({
    databaseUrl: inject('apiDatabaseUrls').migratorUrl,
    maxConnections: 2,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

describe('seedDemoWorkspace', () => {
  it('creates three users with distinct random passwords and a consistent demo project', async () => {
    const result = await seedDemoWorkspace(prisma);
    expect(result.created).toBe(true);
    if (!result.created) return;
    expect(result.credentials.map((c) => c.email)).toEqual([
      `owner@${DEMO_DOMAIN}`,
      `editor@${DEMO_DOMAIN}`,
      `viewer@${DEMO_DOMAIN}`,
    ]);
    expect(new Set(result.credentials.map((c) => c.password)).size).toBe(3);
    expect(result.credentials.every((c) => c.password.length >= 20)).toBe(true);

    const { rows } = await db.query<{
      roles: string[];
      masters: number;
      channels: number;
      items: number;
    }>(`
      SELECT (SELECT array_agg(role::text ORDER BY role) FROM project_members) AS roles,
             (SELECT count(*)::int FROM characters c JOIN character_versions v ON v.id = c.master_version_id
               WHERE v.status = 'approved')
           + (SELECT count(*)::int FROM environments e JOIN environment_versions v ON v.id = e.master_version_id
               WHERE v.status = 'approved') AS masters,
             (SELECT count(*)::int FROM channels) AS channels,
             (SELECT count(*)::int FROM content_items) AS items`);
    expect(rows[0]).toEqual({
      roles: ['owner', 'editor', 'viewer'],
      masters: 2,
      channels: 1,
      items: 1,
    });
  });

  it('is idempotent', async () => {
    expect(await seedDemoWorkspace(prisma)).toEqual({ created: false });
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    expect(rows[0]?.n).toBe(3);
  });
});
