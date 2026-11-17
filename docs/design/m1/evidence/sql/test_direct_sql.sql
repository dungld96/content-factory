\set ON_ERROR_STOP 1
SET client_min_messages = warning;
CREATE TEMP TABLE results (name text, ok boolean, detail text);

-- expect(statement, sqlstate): statement must fail with the given SQLSTATE.
CREATE FUNCTION pg_temp.expect(name text, stmt text, code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (name, false, 'no error raised');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results VALUES (name, SQLSTATE = code, SQLSTATE || ' ' || SQLERRM);
  END;
END $$;
CREATE FUNCTION pg_temp.expect_ok(name text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (name, true, 'ok');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results VALUES (name, false, SQLSTATE || ' ' || SQLERRM);
  END;
END $$;

-- fixtures ------------------------------------------------------------------
INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES
  ('00000000-0000-7000-8000-000000000001', 'owner@example.test', 'Owner', 'x', now()),
  ('00000000-0000-7000-8000-000000000002', 'editor@example.test', 'Editor', 'x', now());

BEGIN;
INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at) VALUES
  ('10000000-0000-7000-8000-000000000001', 'P1', 'p1', 'vi', 'Asia/Ho_Chi_Minh', '00000000-0000-7000-8000-000000000001', now()),
  ('10000000-0000-7000-8000-000000000002', 'P2', 'p2', 'vi', 'Asia/Ho_Chi_Minh', '00000000-0000-7000-8000-000000000001', now());
INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
  ('10000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', 'owner', now()),
  ('10000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'editor', now()),
  ('10000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'owner', now());
COMMIT;

INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at) VALUES
  ('20000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'reference', 'upload', 'p1/a1.png', 'image/png', 100, repeat('a', 64), '00000000-0000-7000-8000-000000000001', now()),
  ('20000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', 'reference', 'upload', 'p1/a2.png', 'image/png', 200, repeat('b', 64), '00000000-0000-7000-8000-000000000001', now()),
  ('20000000-0000-7000-8000-000000000009', '10000000-0000-7000-8000-000000000002', 'reference', 'upload', 'p2/a9.png', 'image/png', 300, repeat('c', 64), '00000000-0000-7000-8000-000000000001', now());

INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at) VALUES
  ('30000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'Khanh', 'khanh', '00000000-0000-7000-8000-000000000001', now());
INSERT INTO character_versions (id, project_id, character_id, version, description, primary_asset_id, created_by_id, updated_at) VALUES
  ('31000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', '30000000-0000-7000-8000-000000000001', 1, 'v1', '20000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', now()),
  ('31000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', '30000000-0000-7000-8000-000000000001', 2, 'v2', NULL, '00000000-0000-7000-8000-000000000001', now());
INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES
  ('10000000-0000-7000-8000-000000000001', '31000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000002');

-- approve v1 correctly (version + pointer in one transaction)
BEGIN;
UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000002'
  WHERE id = '31000000-0000-7000-8000-000000000001';
UPDATE characters SET master_version_id = '31000000-0000-7000-8000-000000000001' WHERE id = '30000000-0000-7000-8000-000000000001';
COMMIT;
INSERT INTO results VALUES ('approve v1 + set master atomically', true, 'ok');

-- versions ------------------------------------------------------------------
SELECT pg_temp.expect('approved version: UPDATE description',
  $$UPDATE character_versions SET description = 'tampered' WHERE id = '31000000-0000-7000-8000-000000000001'$$, 'AC001');
SELECT pg_temp.expect('approved version: revert to draft',
  $$UPDATE character_versions SET status = 'draft', approved_at = NULL, approved_by_id = NULL WHERE id = '31000000-0000-7000-8000-000000000001'$$, 'AC001');
SELECT pg_temp.expect('approved version: DELETE',
  $$DELETE FROM character_versions WHERE id = '31000000-0000-7000-8000-000000000001'$$, 'AC001');
SELECT pg_temp.expect('insert version directly as approved',
  $$INSERT INTO character_versions (project_id, id, character_id, version, status, description, created_by_id, approved_by_id, approved_at, updated_at)
    VALUES ('10000000-0000-7000-8000-000000000001', '31000000-0000-7000-8000-0000000000aa', '30000000-0000-7000-8000-000000000001', 9, 'approved', 'x',
            '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', now(), now())$$, 'AC009');
SELECT pg_temp.expect('draft: change version number',
  $$UPDATE character_versions SET version = 7 WHERE id = '31000000-0000-7000-8000-000000000002'$$, 'AC001');
SELECT pg_temp.expect_ok('draft: edit description',
  $$UPDATE character_versions SET description = 'v2 edited' WHERE id = '31000000-0000-7000-8000-000000000002'$$);
SELECT pg_temp.expect('approve without updating master (deferred check at COMMIT)',
  $$UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
    WHERE id = '31000000-0000-7000-8000-000000000002'; SET CONSTRAINTS ALL IMMEDIATE$$, 'AC004');
SELECT pg_temp.expect('approval CHECK: approved without approved_by',
  $$UPDATE character_versions SET status = 'approved', approved_at = now() WHERE id = '31000000-0000-7000-8000-000000000002'$$, '23514');

-- links -----------------------------------------------------------------------
SELECT pg_temp.expect('approved version: add asset link',
  $$INSERT INTO character_version_assets (project_id, character_version_id, asset_id)
    VALUES ('10000000-0000-7000-8000-000000000001', '31000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000001')$$, 'AC002');
SELECT pg_temp.expect('approved version: remove asset link',
  $$DELETE FROM character_version_assets WHERE character_version_id = '31000000-0000-7000-8000-000000000001'$$, 'AC002');
SELECT pg_temp.expect('approved version: reorder link',
  $$UPDATE character_version_assets SET sort_order = 5 WHERE character_version_id = '31000000-0000-7000-8000-000000000001'$$, 'AC002');
SELECT pg_temp.expect_ok('draft version: add asset link',
  $$INSERT INTO character_version_assets (project_id, character_version_id, asset_id)
    VALUES ('10000000-0000-7000-8000-000000000001', '31000000-0000-7000-8000-000000000002', '20000000-0000-7000-8000-000000000002')$$);
SELECT pg_temp.expect('cross-project asset link (composite FK)',
  $$INSERT INTO character_version_assets (project_id, character_version_id, asset_id)
    VALUES ('10000000-0000-7000-8000-000000000001', '31000000-0000-7000-8000-000000000002', '20000000-0000-7000-8000-000000000009')$$, '23503');
SELECT pg_temp.expect('cross-project primary asset (composite FK)',
  $$UPDATE character_versions SET primary_asset_id = '20000000-0000-7000-8000-000000000009' WHERE id = '31000000-0000-7000-8000-000000000002'$$, '23503');

-- master pointer --------------------------------------------------------------
SELECT pg_temp.expect('master -> draft version',
  $$UPDATE characters SET master_version_id = '31000000-0000-7000-8000-000000000002' WHERE id = '30000000-0000-7000-8000-000000000001'$$, 'AC003');
SELECT pg_temp.expect('master cleared',
  $$UPDATE characters SET master_version_id = NULL WHERE id = '30000000-0000-7000-8000-000000000001'$$, 'AC003');
SELECT pg_temp.expect('character DELETE',
  $$DELETE FROM characters WHERE id = '30000000-0000-7000-8000-000000000001'$$, 'AC006');

-- approve v2 properly, then try to move master back to v1
BEGIN;
UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000002'
  WHERE id = '31000000-0000-7000-8000-000000000002';
UPDATE characters SET master_version_id = '31000000-0000-7000-8000-000000000002' WHERE id = '30000000-0000-7000-8000-000000000001';
COMMIT;
INSERT INTO results VALUES ('approve v2 + move master forward', true, 'ok');
SELECT pg_temp.expect('master moved backwards (v2 -> v1)',
  $$UPDATE characters SET master_version_id = '31000000-0000-7000-8000-000000000001' WHERE id = '30000000-0000-7000-8000-000000000001'$$, 'AC003');

-- assets ------------------------------------------------------------------------
SELECT pg_temp.expect('asset: change storage_key', $$UPDATE assets SET storage_key = 'p1/other.png' WHERE id = '20000000-0000-7000-8000-000000000002'$$, 'AC005');
SELECT pg_temp.expect('asset: change checksum', $$UPDATE assets SET checksum_sha256 = repeat('d', 64) WHERE id = '20000000-0000-7000-8000-000000000002'$$, 'AC005');
SELECT pg_temp.expect('asset: change size', $$UPDATE assets SET size_bytes = 1 WHERE id = '20000000-0000-7000-8000-000000000002'$$, 'AC005');
SELECT pg_temp.expect('asset: change mime', $$UPDATE assets SET mime_type = 'image/jpeg' WHERE id = '20000000-0000-7000-8000-000000000002'$$, 'AC005');
SELECT pg_temp.expect('asset: DELETE', $$DELETE FROM assets WHERE id = '20000000-0000-7000-8000-000000000002'$$, 'AC006');
SELECT pg_temp.expect('asset: archive while used by approved version', $$UPDATE assets SET archived_at = now() WHERE id = '20000000-0000-7000-8000-000000000001'$$, 'AC008');
SELECT pg_temp.expect_ok('asset: edit label/metadata', $$UPDATE assets SET label = 'front', metadata = '{"pose":"front"}' WHERE id = '20000000-0000-7000-8000-000000000001'$$);
SELECT pg_temp.expect('asset: derived without source (CHECK)',
  $$INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at)
    VALUES (gen_random_uuid(), '10000000-0000-7000-8000-000000000001', 'image', 'derived', 'p1/d.png', 'image/png', 1, repeat('e', 64), '00000000-0000-7000-8000-000000000001', now())$$, '23514');
SELECT pg_temp.expect('asset: cross-project lineage (composite FK)',
  $$INSERT INTO assets (id, project_id, asset_type, source_type, source_asset_id, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at)
    VALUES (gen_random_uuid(), '10000000-0000-7000-8000-000000000001', 'image', 'derived', '20000000-0000-7000-8000-000000000009', 'p1/x.png', 'image/png', 1, repeat('f', 64), '00000000-0000-7000-8000-000000000001', now())$$, '23503');
SELECT pg_temp.expect_ok('asset: same-project derived asset',
  $$INSERT INTO assets (id, project_id, asset_type, source_type, source_asset_id, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at)
    VALUES ('20000000-0000-7000-8000-000000000003', '10000000-0000-7000-8000-000000000001', 'image', 'derived', '20000000-0000-7000-8000-000000000001', 'p1/a1-crop.png', 'image/png', 50, repeat('0', 64), '00000000-0000-7000-8000-000000000001', now())$$);
SELECT pg_temp.expect('asset: re-parent lineage', $$UPDATE assets SET source_asset_id = '20000000-0000-7000-8000-000000000002' WHERE id = '20000000-0000-7000-8000-000000000003'$$, 'AC005');

-- owners ----------------------------------------------------------------------
SELECT pg_temp.expect('demote last owner', $$UPDATE project_members SET role = 'editor' WHERE project_id = '10000000-0000-7000-8000-000000000002'; SET CONSTRAINTS ALL IMMEDIATE$$, 'AC007');
SELECT pg_temp.expect('delete last owner', $$DELETE FROM project_members WHERE project_id = '10000000-0000-7000-8000-000000000002'; SET CONSTRAINTS ALL IMMEDIATE$$, 'AC007');
SELECT pg_temp.expect('create project without owner',
  $$INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
    VALUES (gen_random_uuid(), 'P3', 'p3', 'vi', 'UTC', '00000000-0000-7000-8000-000000000001', now()); SET CONSTRAINTS ALL IMMEDIATE$$, 'AC007');
SELECT pg_temp.expect('project DELETE', $$DELETE FROM projects WHERE id = '10000000-0000-7000-8000-000000000002'$$, 'AC006');

-- sessions --------------------------------------------------------------------
SELECT pg_temp.expect('session id_hash wrong length',
  $$INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at) VALUES ('\x01', '00000000-0000-7000-8000-000000000001', '{}', now(), now())$$, '23514');
SELECT pg_temp.expect('user email not normalized',
  $$INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES (gen_random_uuid(), 'Mixed@Example.test', 'x', 'x', now())$$, '23514');

-- lineage traversal (forward = children via index, reverse = ancestors via recursive CTE)
SELECT pg_temp.expect_ok('lineage: ancestors via recursive CTE', $$
  WITH RECURSIVE chain AS (
    SELECT id, source_asset_id, 0 AS depth FROM assets WHERE id = '20000000-0000-7000-8000-000000000003'
    UNION ALL
    SELECT a.id, a.source_asset_id, c.depth + 1 FROM assets a JOIN chain c ON a.id = c.source_asset_id WHERE c.depth < 50)
  SELECT count(*) FROM chain$$);


-- CRITICAL-2 regression: approval must reject archived primary/linked assets ------------------
INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at) VALUES
  ('20000000-0000-7000-8000-000000000011', '10000000-0000-7000-8000-000000000001', 'reference', 'upload', 'p1/arch-primary.png', 'image/png', 10, repeat('1', 64), '00000000-0000-7000-8000-000000000001', now()),
  ('20000000-0000-7000-8000-000000000012', '10000000-0000-7000-8000-000000000001', 'reference', 'upload', 'p1/arch-link.png', 'image/png', 10, repeat('2', 64), '00000000-0000-7000-8000-000000000001', now()),
  ('20000000-0000-7000-8000-000000000013', '10000000-0000-7000-8000-000000000001', 'reference', 'upload', 'p1/env-link.png', 'image/png', 10, repeat('3', 64), '00000000-0000-7000-8000-000000000001', now());
INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at) VALUES
  ('30000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', 'Minh', 'minh', '00000000-0000-7000-8000-000000000001', now());
INSERT INTO character_versions (id, project_id, character_id, version, description, primary_asset_id, created_by_id, updated_at) VALUES
  ('32000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', '30000000-0000-7000-8000-000000000002', 1, 'primary archived', '20000000-0000-7000-8000-000000000011', '00000000-0000-7000-8000-000000000001', now()),
  ('32000000-0000-7000-8000-000000000002', '10000000-0000-7000-8000-000000000001', '30000000-0000-7000-8000-000000000002', 2, 'link archived', NULL, '00000000-0000-7000-8000-000000000001', now());
INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES
  ('10000000-0000-7000-8000-000000000001', '32000000-0000-7000-8000-000000000002', '20000000-0000-7000-8000-000000000012');
SELECT pg_temp.expect_ok('U4: archive asset used only by drafts (allowed)',
  $$UPDATE assets SET archived_at = now() WHERE id IN ('20000000-0000-7000-8000-000000000011', '20000000-0000-7000-8000-000000000012')$$);
SELECT pg_temp.expect('approve draft whose PRIMARY asset is archived',
  $$UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
      WHERE id = '32000000-0000-7000-8000-000000000001';
    UPDATE characters SET master_version_id = '32000000-0000-7000-8000-000000000001' WHERE id = '30000000-0000-7000-8000-000000000002'$$, 'AC010');
SELECT pg_temp.expect('approve draft with a LINKED archived asset',
  $$UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
      WHERE id = '32000000-0000-7000-8000-000000000002';
    UPDATE characters SET master_version_id = '32000000-0000-7000-8000-000000000002' WHERE id = '30000000-0000-7000-8000-000000000002'$$, 'AC010');
SELECT pg_temp.expect('same txn: approve, then archive its asset',
  $$UPDATE assets SET archived_at = NULL WHERE id = '20000000-0000-7000-8000-000000000011';
    UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
      WHERE id = '32000000-0000-7000-8000-000000000001';
    UPDATE characters SET master_version_id = '32000000-0000-7000-8000-000000000001' WHERE id = '30000000-0000-7000-8000-000000000002';
    UPDATE assets SET archived_at = now() WHERE id = '20000000-0000-7000-8000-000000000011'$$, 'AC008');
SELECT pg_temp.expect_ok('unarchive then approve succeeds (control)',
  $$UPDATE assets SET archived_at = NULL WHERE id = '20000000-0000-7000-8000-000000000012';
    UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
      WHERE id = '32000000-0000-7000-8000-000000000002';
    UPDATE characters SET master_version_id = '32000000-0000-7000-8000-000000000002' WHERE id = '30000000-0000-7000-8000-000000000002';
    SET CONSTRAINTS ALL IMMEDIATE$$);

-- environments get the same guards ----------------------------------------------------------
INSERT INTO environments (id, project_id, name, slug, created_by_id, updated_at) VALUES
  ('40000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', 'Office', 'office', '00000000-0000-7000-8000-000000000001', now());
INSERT INTO environment_versions (id, project_id, environment_id, version, description, created_by_id, updated_at) VALUES
  ('41000000-0000-7000-8000-000000000001', '10000000-0000-7000-8000-000000000001', '40000000-0000-7000-8000-000000000001', 1, 'env v1', '00000000-0000-7000-8000-000000000001', now());
INSERT INTO environment_version_assets (project_id, environment_version_id, asset_id) VALUES
  ('10000000-0000-7000-8000-000000000001', '41000000-0000-7000-8000-000000000001', '20000000-0000-7000-8000-000000000013');
UPDATE assets SET archived_at = now() WHERE id = '20000000-0000-7000-8000-000000000013';
SELECT pg_temp.expect('environment: approve with archived linked asset',
  $$UPDATE environment_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
      WHERE id = '41000000-0000-7000-8000-000000000001';
    UPDATE environments SET master_version_id = '41000000-0000-7000-8000-000000000001' WHERE id = '40000000-0000-7000-8000-000000000001'$$, 'AC010');
UPDATE assets SET archived_at = NULL WHERE id = '20000000-0000-7000-8000-000000000013';
BEGIN;
UPDATE environment_versions SET status = 'approved', approved_at = now(), approved_by_id = '00000000-0000-7000-8000-000000000001'
  WHERE id = '41000000-0000-7000-8000-000000000001';
UPDATE environments SET master_version_id = '41000000-0000-7000-8000-000000000001' WHERE id = '40000000-0000-7000-8000-000000000001';
COMMIT;
INSERT INTO results VALUES ('environment: approve + set master atomically', true, 'ok');
SELECT pg_temp.expect('environment: approved version immutable',
  $$UPDATE environment_versions SET description = 'x' WHERE id = '41000000-0000-7000-8000-000000000001'$$, 'AC001');
SELECT pg_temp.expect('environment: approved links frozen',
  $$DELETE FROM environment_version_assets WHERE environment_version_id = '41000000-0000-7000-8000-000000000001'$$, 'AC002');
SELECT pg_temp.expect('environment: archive asset used by approved version',
  $$UPDATE assets SET archived_at = now() WHERE id = '20000000-0000-7000-8000-000000000013'$$, 'AC008');
SELECT pg_temp.expect('environment DELETE', $$DELETE FROM environments WHERE id = '40000000-0000-7000-8000-000000000001'$$, 'AC006');

SELECT (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) AS result, name, detail FROM results;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;
