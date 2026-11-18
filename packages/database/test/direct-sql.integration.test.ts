// Integrity layer under direct SQL (ADR-0011): every CHECK, composite FK and trigger rejects the
// forbidden operation with the expected SQLSTATE, whoever issues it. Ported from the M1 design
// evidence (docs/design/m1/evidence/sql/test_direct_sql.sql) and run as the runtime role
// acf_app, so it also proves the rules bind the application's own credentials.
// Checks run in file order and build on each other's committed state.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commit, connect, sqlStateOfAttempt, truncateAll } from './support/db.js';

const U1 = '00000000-0000-7000-8000-000000000001';
const U2 = '00000000-0000-7000-8000-000000000002';
const P1 = '10000000-0000-7000-8000-000000000001';
const P2 = '10000000-0000-7000-8000-000000000002';
const A1 = '20000000-0000-7000-8000-000000000001';
const A2 = '20000000-0000-7000-8000-000000000002';
const A3 = '20000000-0000-7000-8000-000000000003';
const A9 = '20000000-0000-7000-8000-000000000009'; // belongs to P2
const C1 = '30000000-0000-7000-8000-000000000001';
const V1 = '31000000-0000-7000-8000-000000000001';
const V2 = '31000000-0000-7000-8000-000000000002';
const MASTER1 = '58000000-0000-7000-8000-000000000001';
const insertMaster = (id: string) =>
  `INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at)
     VALUES ('${id}', '${P1}', 'M', '{}', 'vi', '${U1}', now());`;

let migrator: pg.Client;
let app: pg.Client;

const fails = (sql: string) => sqlStateOfAttempt(app, sql);
const approve = (table: string, id: string, by = U1) =>
  `UPDATE ${table} SET status = 'approved', approved_at = now(), approved_by_id = '${by}' WHERE id = '${id}'`;
const setMaster = (table: string, id: string, version: string) =>
  `UPDATE ${table} SET master_version_id = '${version}' WHERE id = '${id}'`;
const insertAsset = (id: string, project: string, key: string, checksumChar: string, extra = '') =>
  `INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at${extra ? ', source_asset_id' : ''})
   VALUES ('${id}', '${project}', 'reference', ${extra ? "'derived'" : "'upload'"}, '${key}', 'image/png', 10, repeat('${checksumChar}', 64), '${U1}', now()${extra ? `, '${extra}'` : ''})`;

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
  await truncateAll(migrator);

  await app.query(`INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES
    ('${U1}', 'owner@example.test', 'Owner', 'x', now()), ('${U2}', 'editor@example.test', 'Editor', 'x', now())`);
  await commit(
    app,
    `INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at) VALUES
       ('${P1}', 'P1', 'p1', 'vi', 'Asia/Ho_Chi_Minh', '${U1}', now()),
       ('${P2}', 'P2', 'p2', 'vi', 'Asia/Ho_Chi_Minh', '${U1}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
       ('${P1}', '${U1}', 'owner', now()), ('${P1}', '${U2}', 'editor', now()), ('${P2}', '${U1}', 'owner', now())`,
  );
  await app.query(insertAsset(A1, P1, 'p1/a1.png', 'a'));
  await app.query(insertAsset(A2, P1, 'p1/a2.png', 'b'));
  await app.query(insertAsset(A9, P2, 'p2/a9.png', 'c'));
  await app.query(`INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at)
    VALUES ('${C1}', '${P1}', 'Khanh', 'khanh', '${U1}', now())`);
  await app.query(`INSERT INTO character_versions (id, project_id, character_id, version, description, primary_asset_id, created_by_id, updated_at) VALUES
    ('${V1}', '${P1}', '${C1}', 1, 'v1', '${A1}', '${U1}', now()),
    ('${V2}', '${P1}', '${C1}', 2, 'v2', NULL, '${U1}', now())`);
  await app.query(`INSERT INTO character_version_assets (project_id, character_version_id, asset_id)
    VALUES ('${P1}', '${V1}', '${A2}')`);
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe('character versions', () => {
  it('approves v1 and sets the master in one transaction', async () => {
    await commit(
      app,
      `${approve('character_versions', V1, U2)}; ${setMaster('characters', C1, V1)}`,
    );
    const { rows } = await app.query<{ master_version_id: string }>(
      `SELECT master_version_id FROM characters WHERE id = '${C1}'`,
    );
    expect(rows[0]?.master_version_id).toBe(V1);
  });

  it.each([
    [
      'UPDATE an approved version',
      `UPDATE character_versions SET description = 'tampered' WHERE id = '${V1}'`,
      'AC001',
    ],
    [
      'revert an approved version to draft',
      `UPDATE character_versions SET status = 'draft', approved_at = NULL, approved_by_id = NULL WHERE id = '${V1}'`,
      'AC001',
    ],
    ['DELETE an approved version', `DELETE FROM character_versions WHERE id = '${V1}'`, 'AC001'],
    [
      'insert a version directly as approved',
      `INSERT INTO character_versions (project_id, id, character_id, version, status, description, created_by_id, approved_by_id, approved_at, updated_at)
       VALUES ('${P1}', '31000000-0000-7000-8000-0000000000aa', '${C1}', 9, 'approved', 'x', '${U1}', '${U1}', now(), now())`,
      'AC009',
    ],
    [
      "change a draft's version number",
      `UPDATE character_versions SET version = 7 WHERE id = '${V2}'`,
      'AC001',
    ],
    [
      'approve without moving the master (deferred, at COMMIT)',
      approve('character_versions', V2),
      'AC004',
    ],
    [
      'approve without approved_by (CHECK)',
      `UPDATE character_versions SET status = 'approved', approved_at = now() WHERE id = '${V2}'`,
      '23514',
    ],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });

  it('allows editing a draft', async () => {
    await commit(app, `UPDATE character_versions SET description = 'v2 edited' WHERE id = '${V2}'`);
  });
});

describe('version asset links', () => {
  it.each([
    [
      'add a link to an approved version',
      `INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES ('${P1}', '${V1}', '${A1}')`,
      'AC002',
    ],
    [
      'remove a link of an approved version',
      `DELETE FROM character_version_assets WHERE character_version_id = '${V1}'`,
      'AC002',
    ],
    [
      'reorder a link of an approved version',
      `UPDATE character_version_assets SET sort_order = 5 WHERE character_version_id = '${V1}'`,
      'AC002',
    ],
    [
      'link another project’s asset (composite FK)',
      `INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES ('${P1}', '${V2}', '${A9}')`,
      '23503',
    ],
    [
      'use another project’s asset as primary (composite FK)',
      `UPDATE character_versions SET primary_asset_id = '${A9}' WHERE id = '${V2}'`,
      '23503',
    ],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });

  it('allows linking an asset to a draft', async () => {
    await commit(
      app,
      `INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES ('${P1}', '${V2}', '${A2}')`,
    );
  });
});

describe('master pointer', () => {
  it.each([
    ['point the master at a draft', setMaster('characters', C1, V2), 'AC003'],
    [
      'clear the master',
      `UPDATE characters SET master_version_id = NULL WHERE id = '${C1}'`,
      'AC003',
    ],
    ['DELETE a character', `DELETE FROM characters WHERE id = '${C1}'`, 'AC006'],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });

  it('moves forward when v2 is approved, and never backwards', async () => {
    await commit(
      app,
      `${approve('character_versions', V2, U2)}; ${setMaster('characters', C1, V2)}`,
    );
    expect(await fails(setMaster('characters', C1, V1))).toBe('AC003');
  });
});

describe('assets', () => {
  it.each([
    [
      'change storage_key',
      `UPDATE assets SET storage_key = 'p1/other.png' WHERE id = '${A2}'`,
      'AC005',
    ],
    [
      'change checksum',
      `UPDATE assets SET checksum_sha256 = repeat('d', 64) WHERE id = '${A2}'`,
      'AC005',
    ],
    ['change size', `UPDATE assets SET size_bytes = 1 WHERE id = '${A2}'`, 'AC005'],
    ['change mime type', `UPDATE assets SET mime_type = 'image/jpeg' WHERE id = '${A2}'`, 'AC005'],
    ['DELETE an asset', `DELETE FROM assets WHERE id = '${A2}'`, 'AC006'],
    [
      'archive an asset used by an approved version',
      `UPDATE assets SET archived_at = now() WHERE id = '${A1}'`,
      'AC008',
    ],
    [
      'insert a derived asset without a source (CHECK)',
      `INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at)
       VALUES (gen_random_uuid(), '${P1}', 'image', 'derived', 'p1/d.png', 'image/png', 1, repeat('e', 64), '${U1}', now())`,
      '23514',
    ],
    [
      'insert lineage across projects (composite FK)',
      insertAsset('20000000-0000-7000-8000-0000000000ff', P1, 'p1/x.png', 'f', A9),
      '23503',
    ],
    [
      'insert an invalid checksum (CHECK)',
      insertAsset('20000000-0000-7000-8000-0000000000fe', P1, 'p1/y.png', 'Z'),
      '23514',
    ],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });

  it('allows editing label and metadata', async () => {
    await commit(
      app,
      `UPDATE assets SET label = 'front', metadata = '{"pose":"front"}' WHERE id = '${A1}'`,
    );
  });

  it('allows a same-project derived asset but never re-parenting it', async () => {
    await commit(app, insertAsset(A3, P1, 'p1/a1-crop.png', '0', A1));
    expect(await fails(`UPDATE assets SET source_asset_id = '${A2}' WHERE id = '${A3}'`)).toBe(
      'AC005',
    );
  });

  it('traverses lineage to the ancestors with a bounded recursive CTE', async () => {
    const { rows } = await app.query<{ id: string }>(`
      WITH RECURSIVE chain AS (
        SELECT id, source_asset_id, 0 AS depth FROM assets WHERE id = '${A3}'
        UNION ALL
        SELECT a.id, a.source_asset_id, c.depth + 1 FROM assets a JOIN chain c ON a.id = c.source_asset_id WHERE c.depth < 50)
      SELECT id FROM chain ORDER BY depth`);
    expect(rows.map((r) => r.id)).toEqual([A3, A1]);
  });
});

describe('project owners', () => {
  it.each([
    [
      'demote the last owner',
      `UPDATE project_members SET role = 'editor' WHERE project_id = '${P2}'`,
      'AC007',
    ],
    ['delete the last owner', `DELETE FROM project_members WHERE project_id = '${P2}'`, 'AC007'],
    [
      'create a project without an owner',
      `INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
       VALUES (gen_random_uuid(), 'P3', 'p3', 'vi', 'UTC', '${U1}', now())`,
      'AC007',
    ],
    ['DELETE a project', `DELETE FROM projects WHERE id = '${P2}'`, 'AC006'],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });
});

describe('identity', () => {
  it.each([
    [
      'a session id_hash that is not 32 bytes',
      `INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at) VALUES ('\\x01', '${U1}', '{}', now(), now())`,
      '23514',
    ],
    [
      'a session whose idle expiry exceeds the absolute expiry',
      `INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at)
       VALUES (decode(repeat('ab', 32), 'hex'), '${U1}', '{}', now() + interval '2 days', now() + interval '1 day')`,
      '23514',
    ],
    [
      'a non-normalized email',
      `INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES (gen_random_uuid(), 'Mixed@Example.test', 'x', 'x', now())`,
      '23514',
    ],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });

  it('rejects deleting a user who authored rows (RESTRICT FK)', async () => {
    expect(await fails(`DELETE FROM users WHERE id = '${U1}'`)).toBe('23503');
  });
});

describe('approval with archived assets (CRITICAL-2 regression, decision U4)', () => {
  const C2 = '30000000-0000-7000-8000-000000000002';
  const W1 = '32000000-0000-7000-8000-000000000001';
  const W2 = '32000000-0000-7000-8000-000000000002';
  const AP = '20000000-0000-7000-8000-000000000011';
  const AL = '20000000-0000-7000-8000-000000000012';

  beforeAll(async () => {
    await app.query(insertAsset(AP, P1, 'p1/arch-primary.png', '1'));
    await app.query(insertAsset(AL, P1, 'p1/arch-link.png', '2'));
    await app.query(`INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at)
      VALUES ('${C2}', '${P1}', 'Minh', 'minh', '${U1}', now())`);
    await app.query(`INSERT INTO character_versions (id, project_id, character_id, version, description, primary_asset_id, created_by_id, updated_at) VALUES
      ('${W1}', '${P1}', '${C2}', 1, 'primary archived', '${AP}', '${U1}', now()),
      ('${W2}', '${P1}', '${C2}', 2, 'link archived', NULL, '${U1}', now())`);
    await app.query(`INSERT INTO character_version_assets (project_id, character_version_id, asset_id)
      VALUES ('${P1}', '${W2}', '${AL}')`);
  });

  it('allows archiving assets used only by drafts', async () => {
    await commit(app, `UPDATE assets SET archived_at = now() WHERE id IN ('${AP}', '${AL}')`);
  });

  it.each([
    [
      'approve a draft whose PRIMARY asset is archived',
      `${approve('character_versions', W1)}; ${setMaster('characters', C2, W1)}`,
      'AC010',
    ],
    [
      'approve a draft with a LINKED archived asset',
      `${approve('character_versions', W2)}; ${setMaster('characters', C2, W2)}`,
      'AC010',
    ],
    [
      'approve, then archive its asset in the same transaction',
      `UPDATE assets SET archived_at = NULL WHERE id = '${AP}'; ${approve('character_versions', W1)};
       ${setMaster('characters', C2, W1)}; UPDATE assets SET archived_at = now() WHERE id = '${AP}'`,
      'AC008',
    ],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });

  it('allows unarchive-then-approve (control)', async () => {
    await commit(
      app,
      `UPDATE assets SET archived_at = NULL WHERE id = '${AL}'; ${approve('character_versions', W2)}; ${setMaster('characters', C2, W2)}`,
    );
  });
});

describe('environments have the same guards', () => {
  const E1 = '40000000-0000-7000-8000-000000000001';
  const EV1 = '41000000-0000-7000-8000-000000000001';
  const AE = '20000000-0000-7000-8000-000000000013';

  beforeAll(async () => {
    await app.query(insertAsset(AE, P1, 'p1/env-link.png', '3'));
    await app.query(`INSERT INTO environments (id, project_id, name, slug, created_by_id, updated_at)
      VALUES ('${E1}', '${P1}', 'Office', 'office', '${U1}', now())`);
    await app.query(`INSERT INTO environment_versions (id, project_id, environment_id, version, description, created_by_id, updated_at)
      VALUES ('${EV1}', '${P1}', '${E1}', 1, 'env v1', '${U1}', now())`);
    await app.query(`INSERT INTO environment_version_assets (project_id, environment_version_id, asset_id)
      VALUES ('${P1}', '${EV1}', '${AE}')`);
  });

  it('rejects approval with an archived linked asset', async () => {
    await commit(app, `UPDATE assets SET archived_at = now() WHERE id = '${AE}'`);
    expect(
      await fails(`${approve('environment_versions', EV1)}; ${setMaster('environments', E1, EV1)}`),
    ).toBe('AC010');
    await commit(app, `UPDATE assets SET archived_at = NULL WHERE id = '${AE}'`);
  });

  it('approves and sets the master atomically', async () => {
    await commit(
      app,
      `${approve('environment_versions', EV1)}; ${setMaster('environments', E1, EV1)}`,
    );
  });

  it.each([
    [
      'UPDATE an approved version',
      `UPDATE environment_versions SET description = 'x' WHERE id = '${EV1}'`,
      'AC001',
    ],
    [
      'remove a link of an approved version',
      `DELETE FROM environment_version_assets WHERE environment_version_id = '${EV1}'`,
      'AC002',
    ],
    [
      'archive an asset used by an approved version',
      `UPDATE assets SET archived_at = now() WHERE id = '${AE}'`,
      'AC008',
    ],
    ['DELETE an environment', `DELETE FROM environments WHERE id = '${E1}'`, 'AC006'],
  ])('rejects: %s', async (_name, sql, code) => {
    expect(await fails(sql)).toBe(code);
  });
});

describe('archive-only tables', () => {
  it.each(['channels', 'content_items'])('rejects DELETE on %s (AC006)', async (table) => {
    // The trigger fires per row, so the row must exist for the DELETE to reach it.
    const id = '50000000-0000-7000-8000-000000000001';
    const insert =
      table === 'channels'
        ? `INSERT INTO channels (id, project_id, name, slug, platform, created_by_id, updated_at)
           VALUES ('${id}', '${P1}', 'Main', 'main', 'tiktok', '${U1}', now())`
        : `INSERT INTO content_masters (id, project_id, title, brief, language, created_by_id, updated_at)
             VALUES ('${id}', '${P1}', 'T', '{}', 'vi', '${U1}', now());
           INSERT INTO content_items (id, project_id, content_master_id, title, format, target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at)
           VALUES ('${id}', '${P1}', '${id}', 'T', 'short_video', 30, '9:16', 'vi', '{}', '${U1}', now())`;
    expect(await fails(`${insert}; DELETE FROM ${table} WHERE id = '${id}'`)).toBe('AC006');
  });

  it('rejects a content item outside the 1..600 s duration range (CHECK)', async () => {
    expect(
      await fails(`${insertMaster(MASTER1)}
        INSERT INTO content_items (id, project_id, content_master_id, title, format, target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at)
        VALUES (gen_random_uuid(), '${P1}', '${MASTER1}', 'T', 'short_video', 601, '9:16', 'vi', '{}', '${U1}', now())`),
    ).toBe('23514');
  });

  it('rejects a content item using another project’s channel (composite FK)', async () => {
    const ch = '50000000-0000-7000-8000-000000000002';
    expect(
      await fails(`INSERT INTO channels (id, project_id, name, slug, platform, created_by_id, updated_at)
          VALUES ('${ch}', '${P2}', 'Other', 'other', 'tiktok', '${U1}', now());
        ${insertMaster(MASTER1)}
        INSERT INTO content_items (id, project_id, content_master_id, channel_id, title, format, target_duration_seconds, aspect_ratio, language, brief, created_by_id, updated_at)
          VALUES (gen_random_uuid(), '${P1}', '${MASTER1}', '${ch}', 'T', 'short_video', 30, '9:16', 'vi', '{}', '${U1}', now())`),
    ).toBe('23503');
  });
});
