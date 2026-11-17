// Guards against silent loss of the integrity layer (design package §6.4 items 7–8) and
// verifies the database role separation (ADR-0011 §8, decision U3).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { connect, sqlStateOf } from './support/db.js';

const run = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, '..');

let migrator: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

/** [table, trigger, deferrable] — every trigger the migration must create, enabled. */
const EXPECTED_TRIGGERS: readonly (readonly [string, string, boolean])[] = [
  ['assets', 'assets_guard', false],
  ['assets', 'assets_no_delete', false],
  ['channels', 'channels_no_delete', false],
  ['character_version_assets', 'character_version_assets_guard', false],
  ['character_versions', 'character_versions_approval_sets_master', true],
  ['character_versions', 'character_versions_guard', false],
  ['characters', 'characters_master_guard', false],
  ['characters', 'characters_no_delete', false],
  ['content_items', 'content_items_no_delete', false],
  ['environment_version_assets', 'environment_version_assets_guard', false],
  ['environment_versions', 'environment_versions_approval_sets_master', true],
  ['environment_versions', 'environment_versions_guard', false],
  ['environments', 'environments_master_guard', false],
  ['environments', 'environments_no_delete', false],
  ['project_members', 'project_members_keep_owner', true],
  ['projects', 'projects_created_with_owner', true],
  ['projects', 'projects_no_delete', false],
];

const EXPECTED_CHECKS = [
  'assets.assets_checksum_format',
  'assets.assets_derived_has_source',
  'assets.assets_dimensions_positive',
  'assets.assets_duration_nonnegative',
  'assets.assets_not_own_source',
  'assets.assets_size_nonnegative',
  'assets.assets_storage_key_nonempty',
  'character_versions.character_versions_approval_consistent',
  'character_versions.character_versions_not_based_on_self',
  'character_versions.character_versions_version_positive',
  'content_items.content_items_duration_range',
  'environment_versions.environment_versions_approval_consistent',
  'environment_versions.environment_versions_not_based_on_self',
  'environment_versions.environment_versions_version_positive',
  'sessions.sessions_expiry_order',
  'sessions.sessions_id_hash_len',
  'users.users_email_normalized',
];

describe('integrity layer presence', () => {
  it('has every trigger, enabled, with the expected deferrability', async () => {
    const { rows } = await migrator.query<{
      tbl: string;
      tgname: string;
      tgenabled: string;
      deferrable: boolean;
    }>(`SELECT c.relname AS tbl, t.tgname, t.tgenabled, t.tgdeferrable AS deferrable
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`);
    expect(rows.map((r) => [r.tbl, r.tgname, r.deferrable])).toEqual(EXPECTED_TRIGGERS);
    // 'O' = fires in origin/local mode (enabled). 'D' would mean disabled.
    expect(rows.filter((r) => r.tgenabled !== 'O')).toEqual([]);
  });

  it('has every CHECK constraint, validated', async () => {
    const { rows } = await migrator.query<{ name: string; convalidated: boolean }>(
      `SELECT c.relname || '.' || k.conname AS name, k.convalidated
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND k.contype = 'c' ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_CHECKS);
    expect(rows.every((r) => r.convalidated)).toBe(true);
  });

  it('has no Prisma drift: the migrated database matches schema.prisma', async () => {
    // Triggers, functions and CHECKs are invisible to Prisma, so the diff must be empty.
    const { stdout } = await run(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        path.join('prisma', 'schema.prisma'),
        '--exit-code',
      ],
      {
        cwd: packageDir,
        env: { ...process.env, DATABASE_MIGRATION_URL: inject('databaseUrls').migratorUrl },
      },
    );
    expect(stdout).toContain('No difference detected');
  });
});

describe('role separation (U3)', () => {
  it('runs the app as a non-superuser, non-owner role', async () => {
    const { rows } = await app.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
      owns_tables: boolean;
    }>(`SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
          EXISTS (SELECT 1 FROM pg_tables WHERE tableowner = current_user) AS owns_tables
        FROM pg_roles r WHERE r.rolname = current_user`);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      owns_tables: false,
    });
  });

  it('owns the schema objects through the migrator, which is not a superuser', async () => {
    const { rows } = await migrator.query<{ rolsuper: boolean; foreign_owned: number }>(
      `SELECT r.rolsuper, (SELECT count(*)::int FROM pg_tables
         WHERE schemaname = 'public' AND tableowner <> current_user) AS foreign_owned
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, foreign_owned: 0 });
  });

  it.each([
    ['disable a trigger', 'ALTER TABLE assets DISABLE TRIGGER assets_guard'],
    ['drop a trigger', 'DROP TRIGGER assets_guard ON assets'],
    ['truncate a table', 'TRUNCATE assets CASCADE'],
    ['bypass triggers with session_replication_role', 'SET session_replication_role = replica'],
    [
      'replace a trigger function',
      'CREATE OR REPLACE FUNCTION acf_forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$',
    ],
    ['create a table', 'CREATE TABLE app_owned (id int)'],
    ['write the migration history', `DELETE FROM _prisma_migrations`],
    ['read the migration history', `SELECT 1 FROM _prisma_migrations`],
  ])('denies the app role: %s', async (_name, sql) => {
    let state: string | undefined;
    try {
      await app.query(sql);
    } catch (error) {
      state = sqlStateOf(error);
    }
    // 42501 insufficient_privilege; 42501/42883-family codes all mean "not allowed".
    expect(state).toBe('42501');
  });

  it('grants the app role DML on every domain table', async () => {
    const { rows } = await app.query<{ tablename: string; ok: boolean }>(
      `SELECT tablename, has_table_privilege(current_user, 'public.' || tablename, 'SELECT, INSERT, UPDATE, DELETE') AS ok
       FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    expect(rows.length).toBe(13);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });
});
