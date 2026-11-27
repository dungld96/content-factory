// R0 integrity layer (docs/design/M3.5-multiformat-architecture-review.md §3.4, §5.1; ADR-0015):
// content masters, the variant → master link, the platform/channel rule, and the 1:1 backfill
// of `m35_content_masters` on a database that already holds M3 data.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { dropDatabase, withDatabase } from '../src/admin/index.js';
import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';
import { runSchedule, type Decide, type Step } from './support/lock-matrix.js';

const U = '00000000-0000-7000-8000-000000000001';
const P = '10000000-0000-7000-8000-000000000001';
const P2 = '10000000-0000-7000-8000-000000000002';
const M1 = '58000000-0000-7000-8000-000000000001';
const M2 = '58000000-0000-7000-8000-000000000002';
const M9 = '58000000-0000-7000-8000-000000000009'; // project P2
const CI = '40000000-0000-7000-8000-000000000001';
const CH = '30000000-0000-7000-8000-000000000001';

let migrator: pg.Client;
let app: pg.Client;
const fails = (sql: string) => sqlStateOfAttempt(app, sql);

const master = (id: string, project = P) =>
  `INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at)
     VALUES ('${id}', '${project}', 'M', '{"topic":"t"}', 'vi', '${U}', now())`;
const variant = (id: string, masterId: string, extra: Record<string, string> = {}) => {
  const cols = { content_master_id: `'${masterId}'`, ...extra };
  return `INSERT INTO content_items (id, project_id, title, format, target_duration_seconds, aspect_ratio,
      language, brief, created_by_id, updated_at, ${Object.keys(cols).join(', ')})
    VALUES ('${id}', '${P}', 'V', 'short_video', 30, '9:16', 'vi', '{"topic":"t"}', '${U}', now(),
      ${Object.values(cols).join(', ')})`;
};

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);
  await commit(
    app,
    `INSERT INTO users (id, email, display_name, password_hash, updated_at)
       VALUES ('${U}', 'u@example.test', 'U', 'x', now());
     INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at) VALUES
       ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now()), ('${P2}', 'P2', 'p2', 'vi', 'UTC', '${U}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
       ('${P}', '${U}', 'owner', now()), ('${P2}', '${U}', 'owner', now());
     INSERT INTO channels (id, project_id, name, slug, platform, created_by_id, updated_at)
       VALUES ('${CH}', '${P}', 'Main', 'main', 'tiktok', '${U}', now());
     ${master(M1)}; ${master(M2)}; ${master(M9, P2)};
     ${variant(CI, M1)}`,
  );
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('content masters (R0)', () => {
  it('lets the app role create, edit and archive masters', async () => {
    expect(
      await fails(`UPDATE content_masters SET brief = '{"topic":"u"}', brief_revision = 2,
        archived_at = now() WHERE id = '${M2}'`),
    ).toBeNull();
  });

  it('never hard-deletes a master (AC006)', async () => {
    expect(await fails(`DELETE FROM content_masters WHERE id = '${M2}'`)).toBe('AC006');
  });

  it('requires a positive brief revision (CHECK)', async () => {
    expect(await fails(`UPDATE content_masters SET brief_revision = 0 WHERE id = '${M1}'`)).toBe(
      '23514',
    );
    expect(
      await fails(`UPDATE content_items SET master_brief_revision = 0 WHERE id = '${CI}'`),
    ).toBe('23514');
  });
});

describe('variant → master link', () => {
  it('requires a master (NOT NULL)', async () => {
    expect(
      await fails(`INSERT INTO content_items (id, project_id, title, format, target_duration_seconds,
          aspect_ratio, language, brief, created_by_id, updated_at)
        VALUES (gen_random_uuid(), '${P}', 'V', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now())`),
    ).toBe('23502');
  });

  it('rejects a master of another project (composite FK)', async () => {
    expect(await fails(variant('40000000-0000-7000-8000-000000000002', M9))).toBe('23503');
  });

  it('never moves a variant to another master (AC014)', async () => {
    expect(
      await fails(`UPDATE content_items SET content_master_id = '${M2}' WHERE id = '${CI}'`),
    ).toBe('AC014');
  });

  it('allows several variants of one master', async () => {
    expect(await fails(variant('40000000-0000-7000-8000-000000000003', M1))).toBeNull();
  });
});

describe('target platform', () => {
  it('is stored only for variants without a channel (CHECK)', async () => {
    const id = '40000000-0000-7000-8000-000000000004';
    expect(await fails(variant(id, M1, { target_platform: `'youtube_shorts'` }))).toBeNull();
    expect(await fails(variant(id, M1, { channel_id: `'${CH}'` }))).toBeNull();
    expect(
      await fails(variant(id, M1, { channel_id: `'${CH}'`, target_platform: `'tiktok'` })),
    ).toBe('23514');
  });
});

// Service protocol (apps/api content-masters, READ COMMITTED like every API transaction):
// - create variant: master FOR KEY SHARE → refuse if archived → insert the variant;
// - archive master: master FOR UPDATE → refuse while a variant is active → set archived_at.
// One row lock each, so no deadlock; FOR UPDATE conflicts with FOR KEY SHARE, so an archive
// can never miss a variant created concurrently.
describe('archive master vs create variant (lock boundary, READ COMMITTED)', () => {
  const st = (s: 'A' | 'B', label: string, sql: string, decide?: Decide): Step =>
    decide ? { s, label, sql, decide } : { s, label, sql };
  const lockForVariant = (MC: string) =>
    `SELECT archived_at FROM content_masters WHERE id = '${MC}' FOR KEY SHARE`;
  const notArchived: Decide = (rows) => (rows[0]?.['archived_at'] ? 'MASTER_ARCHIVED' : 'ok');
  const lockForArchive = (MC: string) =>
    `SELECT id FROM content_masters WHERE id = '${MC}' FOR UPDATE`;
  const countActive = (MC: string) => `SELECT count(*)::int AS n FROM content_items
    WHERE content_master_id = '${MC}' AND archived_at IS NULL`;
  const noActive: Decide = (rows) =>
    Number(rows[0]?.['n']) > 0 ? 'MASTER_HAS_ACTIVE_VARIANTS' : 'ok';
  const archive = (MC: string) =>
    `UPDATE content_masters SET archived_at = now() WHERE id = '${MC}'`;

  // Each scenario uses its own master (rows are never deleted).
  const MC1 = '58000000-0000-7000-8000-0000000000c1';
  const MC2 = '58000000-0000-7000-8000-0000000000c2';
  const scenarios: readonly {
    id: string;
    master: string;
    steps: readonly Step[];
    expect: { A: string; B: string };
  }[] = [
    {
      id: 'MC1 variant first, archive waits and sees it',
      master: MC1,
      steps: [
        st('A', 'BEGIN', 'BEGIN ISOLATION LEVEL READ COMMITTED'),
        st('A', 'lock master (key share)', lockForVariant(MC1), notArchived),
        st('A', 'insert variant', variant('40000000-0000-7000-8000-0000000000c1', MC1)),
        st('B', 'BEGIN', 'BEGIN ISOLATION LEVEL READ COMMITTED'),
        st('B', 'lock master (update)', lockForArchive(MC1)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'count active variants', countActive(MC1), noActive),
        st('B', 'archive', archive(MC1)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: 'MASTER_HAS_ACTIVE_VARIANTS' },
    },
    {
      id: 'MC2 archive first, variant creation waits and is refused',
      master: MC2,
      steps: [
        st('B', 'BEGIN', 'BEGIN ISOLATION LEVEL READ COMMITTED'),
        st('B', 'lock master (update)', lockForArchive(MC2)),
        st('B', 'count active variants', countActive(MC2), noActive),
        st('B', 'archive', archive(MC2)),
        st('A', 'BEGIN', 'BEGIN ISOLATION LEVEL READ COMMITTED'),
        st('A', 'lock master (key share)', lockForVariant(MC2), notArchived),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'insert variant', variant('40000000-0000-7000-8000-0000000000c2', MC2)),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'MASTER_ARCHIVED', B: 'commit' },
    },
  ];

  it.each(scenarios.map((sc) => [sc.id, sc] as const))('%s', async (_id, sc) => {
    await app.query(master(sc.master));

    const result = await runSchedule(migrator, inject('databaseUrls').appUrl, sc.steps);
    const context = `${sc.id}\ntrace: ${result.trace.join(' | ')}`;
    expect([result.A, result.B], context).not.toContain('40P01');
    expect({ A: result.A, B: result.B }, context).toEqual(sc.expect);
    expect(result.blockedSteps.length, `never blocked: ${context}`).toBeGreaterThan(0);
    const { rows } = await migrator.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_items i JOIN content_masters m ON m.id = i.content_master_id
        WHERE m.archived_at IS NOT NULL AND i.archived_at IS NULL`,
    );
    expect(rows[0]?.n, `active variant of an archived master: ${context}`).toBe(0);
  });
});

describe('migration m35_content_masters backfill', () => {
  const SCRATCH = 'acf_test_r0_backfill';
  const migrationsDir = path.resolve(import.meta.dirname, '..', 'prisma', 'migrations');
  let scratch: pg.Client;

  async function migrationSql(): Promise<{ before: string[]; r0: string }> {
    const dirs = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const r0Index = dirs.findIndex((d) => d.endsWith('_m35_content_masters'));
    const read = (d: string) => readFile(path.join(migrationsDir, d, 'migration.sql'), 'utf8');
    return {
      before: await Promise.all(dirs.slice(0, r0Index).map(read)),
      r0: await read(dirs[r0Index] ?? ''),
    };
  }

  beforeAll(async () => {
    const urls = inject('databaseUrls');
    const migratorRole = new URL(urls.migratorUrl).username;
    await dropDatabase(urls.adminUrl, SCRATCH);
    const admin = new pg.Client({ connectionString: urls.adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${SCRATCH} OWNER ${pg.escapeIdentifier(migratorRole)}`);
    } finally {
      await admin.end();
    }
    scratch = new pg.Client({ connectionString: withDatabase(urls.migratorUrl, SCRATCH) });
    await scratch.connect();
  });

  afterAll(async () => {
    await scratch.end();
    await dropDatabase(inject('databaseUrls').adminUrl, SCRATCH);
  });

  it('gives every existing content item its own master, copying title, brief and dates', async () => {
    const { before, r0 } = await migrationSql();
    for (const sql of before) await scratch.query(sql);

    const ci1 = '40000000-0000-7000-8000-0000000000a1';
    const ci2 = '40000000-0000-7000-8000-0000000000a2';
    await scratch.query(`BEGIN;
      INSERT INTO users (id, email, display_name, password_hash, updated_at)
        VALUES ('${U}', 'u@example.test', 'U', 'x', now());
      INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
        VALUES ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now());
      INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES ('${P}', '${U}', 'owner', now());
      INSERT INTO channels (id, project_id, name, slug, platform, created_by_id, updated_at)
        VALUES ('${CH}', '${P}', 'Main', 'main', 'youtube_shorts', '${U}', now());
      INSERT INTO content_items (id, project_id, channel_id, title, format, target_duration_seconds,
          aspect_ratio, language, brief, created_by_id, archived_at, created_at, updated_at) VALUES
        ('${ci1}', '${P}', '${CH}', 'With channel', 'short_video', 30, '9:16', 'vi', '{"topic":"a"}',
         '${U}', NULL, '2026-11-01T10:00:00.123Z', '2026-11-02T10:00:00Z'),
        ('${ci2}', '${P}', NULL, 'Archived', 'short_video', 45, '1:1', 'en', '{"topic":"b","tone":"dry"}',
         '${U}', '2026-11-03T10:00:00Z', '2026-11-01T11:00:00Z', '2026-11-03T10:00:00Z');
      COMMIT`);

    await scratch.query(r0);

    const { rows } = await scratch.query<{
      id: string;
      same: boolean;
      version: string;
      ts_ok: boolean;
      revs: string;
      platform: string | null;
      variants: number;
    }>(`SELECT i.id,
          (m.project_id = i.project_id AND m.title = i.title AND m.brief = i.brief
           AND m.language = i.language AND m.created_by_id = i.created_by_id
           AND m.archived_at IS NOT DISTINCT FROM i.archived_at AND m.created_at = i.created_at
           AND m.updated_at = i.updated_at) AS same,
          substr(m.id::text, 15, 1) AS version,
          (('x' || substr(replace(m.id::text, '-', ''), 1, 12))::bit(48)::bigint
             = floor(extract(epoch FROM i.created_at) * 1000)::bigint) AS ts_ok,
          m.brief_revision || '/' || i.master_brief_revision AS revs,
          i.target_platform::text AS platform,
          (SELECT count(*)::int FROM content_items x WHERE x.content_master_id = m.id) AS variants
        FROM content_items i JOIN content_masters m ON m.id = i.content_master_id ORDER BY i.id`);
    expect(rows).toEqual([
      { id: ci1, same: true, version: '7', ts_ok: true, revs: '1/1', platform: null, variants: 1 },
      { id: ci2, same: true, version: '7', ts_ok: true, revs: '1/1', platform: null, variants: 1 },
    ]);

    const leftovers = await scratch.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'acf_tmp_uuid_v7'`,
    );
    expect(leftovers.rowCount).toBe(0);
  });
});
