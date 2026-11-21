// Concurrency scenarios for the lock-boundary harness (M1 design package §6.3, §6.5, §7).
// D1–D8 and O1–O4 are the revision-4 matrix; C2–C4 and S1–S3 port the timed evidence scripts
// (conc.sh, conc_sessions.sh) onto the deterministic harness.
import type pg from 'pg';

import type { Decide, Outcome, Step } from './lock-matrix.js';

export type Isolation = 'READ COMMITTED' | 'REPEATABLE READ';
export type RefMode = 'primary' | 'link';

export interface Scenario {
  readonly id: string;
  readonly what: string;
  readonly steps: readonly Step[];
  readonly expect: { readonly A: Outcome; readonly B: Outcome };
  /** Sequential by design: no lock wait is required to have been observed. */
  readonly overlapOptional?: boolean;
  /** Scenario-specific invariant: returns a description of the violation, or null. */
  readonly check?: (owner: pg.Client) => Promise<string | null>;
}

export const U = '00000000-0000-7000-8000-000000000001';
export const U2 = '00000000-0000-7000-8000-000000000002';
export const P = '10000000-0000-7000-8000-000000000001';
export const X = '20000000-0000-7000-8000-00000000000a';
export const Y = '20000000-0000-7000-8000-00000000000b';
export const C = '30000000-0000-7000-8000-000000000001';
export const C2 = '30000000-0000-7000-8000-000000000002';
export const V1 = '31000000-0000-7000-8000-000000000001';
export const V2 = '31000000-0000-7000-8000-000000000002';
export const W1 = '32000000-0000-7000-8000-000000000001';
/** A 32-byte session id_hash. */
export const SESSION_HASH = `decode(repeat('ab', 32), 'hex')`;

/**
 * Seeds one project with two owners, assets X and Y, characters C (drafts V1, V2) and C2
 * (draft W1), and one live session. `primary`: every version uses X as its primary asset.
 * `link`: every version links both X and Y (exercises multi-row lock ordering).
 * Runs as the app role, inside one transaction (a project must be created with its owner).
 */
export async function seed(app: pg.Client, ref: RefMode): Promise<void> {
  const primary = ref === 'primary' ? `'${X}'` : 'NULL';
  const links =
    ref === 'link'
      ? `INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES
           ('${P}', '${V1}', '${Y}'), ('${P}', '${V1}', '${X}'),
           ('${P}', '${V2}', '${Y}'), ('${P}', '${V2}', '${X}'),
           ('${P}', '${W1}', '${Y}'), ('${P}', '${W1}', '${X}');`
      : '';
  await app.query(`BEGIN;
    INSERT INTO users (id, email, display_name, password_hash, updated_at) VALUES
      ('${U}', 'o1@x.test', 'O1', 'x', now()), ('${U2}', 'o2@x.test', 'O2', 'x', now());
    INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
      VALUES ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now());
    INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES
      ('${P}', '${U}', 'owner', now()), ('${P}', '${U2}', 'owner', now());
    INSERT INTO assets (id, project_id, asset_type, source_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_id, updated_at) VALUES
      ('${X}', '${P}', 'reference', 'upload', 'k/x', 'image/png', 1, repeat('a', 64), '${U}', now()),
      ('${Y}', '${P}', 'reference', 'upload', 'k/y', 'image/png', 1, repeat('b', 64), '${U}', now());
    INSERT INTO characters (id, project_id, name, slug, created_by_id, updated_at) VALUES
      ('${C}', '${P}', 'C', 'c', '${U}', now()), ('${C2}', '${P}', 'C2', 'c2', '${U}', now());
    INSERT INTO character_versions (id, project_id, character_id, version, description, primary_asset_id, created_by_id, updated_at) VALUES
      ('${V1}', '${P}', '${C}', 1, 'v1', ${primary}, '${U}', now()),
      ('${V2}', '${P}', '${C}', 2, 'v2', ${primary}, '${U}', now()),
      ('${W1}', '${P}', '${C2}', 1, 'w1', ${primary}, '${U}', now());
    ${links}
    INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at)
      VALUES (${SESSION_HASH}, '${U}', '{}', now() + interval '1 day', now() + interval '7 days');
    COMMIT`);
}

/** Global invariants that must hold after every scenario, whatever its outcome. */
export async function invariants(owner: pg.Client): Promise<Record<string, number>> {
  const count = async (sql: string) =>
    (await owner.query<{ n: number }>(sql)).rows[0]?.n ?? Number.NaN;
  return {
    approvedWithArchivedAsset: await count(`SELECT count(*)::int AS n FROM character_versions v
      JOIN assets a ON a.archived_at IS NOT NULL AND (a.id = v.primary_asset_id
        OR a.id IN (SELECT asset_id FROM character_version_assets l WHERE l.character_version_id = v.id))
      WHERE v.status = 'approved'`),
    projectsWithoutOwner: await count(`SELECT count(*)::int AS n FROM projects p WHERE NOT EXISTS
      (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.role = 'owner')`),
    masterNotHighestApproved: await count(`SELECT count(*)::int AS n FROM characters c
      WHERE c.master_version_id IS DISTINCT FROM (SELECT id FROM character_versions v
        WHERE v.character_id = c.id AND v.status = 'approved' ORDER BY version DESC LIMIT 1)`),
    approvedLinksAddedAfterApproval:
      await count(`SELECT count(*)::int AS n FROM character_version_assets l
      JOIN character_versions v ON v.id = l.character_version_id
      WHERE v.status = 'approved' AND l.created_at > v.approved_at`),
  };
}

// ------------------------------------------------------------------ SQL building blocks
const begin = (iso: Isolation) => `BEGIN ISOLATION LEVEL ${iso}`;
const approveVersion = (v: string) =>
  `UPDATE character_versions SET status = 'approved', approved_at = now(), approved_by_id = '${U}' WHERE id = '${v}'`;
const movePointer = (c: string, v: string) =>
  `UPDATE characters SET master_version_id = '${v}' WHERE id = '${c}'`;
const archiveX = `UPDATE assets SET archived_at = now() WHERE id = '${X}'`;
// Service approval (§7), lock order version -> parent -> assets (ascending id).
const svcLockVersion = (v: string) =>
  `SELECT id, status::text AS status FROM character_versions WHERE id = '${v}' FOR UPDATE`;
const svcLockParent = (c: string) =>
  `SELECT id FROM characters WHERE id = '${c}' FOR NO KEY UPDATE`;
const svcLockAssets = (v: string) => `SELECT id, archived_at FROM assets WHERE id IN (
    SELECT primary_asset_id FROM character_versions WHERE id = '${v}'
    UNION SELECT asset_id FROM character_version_assets WHERE character_version_id = '${v}')
  ORDER BY id FOR NO KEY UPDATE`;
const svcDecideAssets: Decide = (rows) =>
  rows.some((r) => r['archived_at'] !== null) ? 'ASSET_ARCHIVED' : 'ok';
const svcDecideDraft: Decide = (rows) =>
  rows[0]?.['status'] === 'approved' ? 'ALREADY_APPROVED' : 'ok';
// Service archive (§7): lock the asset, then check usages.
const svcLockAsset = `SELECT id FROM assets WHERE id = '${X}' FOR NO KEY UPDATE`;
const svcUsage = `SELECT count(*)::int AS n FROM character_versions WHERE status = 'approved'
  AND (primary_asset_id = '${X}' OR id IN (SELECT character_version_id FROM character_version_assets WHERE asset_id = '${X}'))`;
const svcDecideUsage: Decide = (rows) => (Number(rows[0]?.['n']) > 0 ? 'ASSET_IN_USE' : 'ok');
// Service last-owner (§7): member row -> project row (write) -> count.
const demote = (u: string) =>
  `UPDATE project_members SET role = 'editor' WHERE project_id = '${P}' AND user_id = '${u}'`;
const svcLockProject = `UPDATE projects SET updated_at = updated_at WHERE id = '${P}'`;
const svcCountOwners = `SELECT count(*)::int AS n FROM project_members WHERE project_id = '${P}' AND role = 'owner'`;
const svcDecideOwners: Decide = (rows) => (Number(rows[0]?.['n']) === 0 ? 'LAST_OWNER' : 'ok');
// Session store (§5.3): UPDATE-only set() vs logout DELETE.
const sessionSet = `UPDATE sessions SET data = '{"userId":"${U}"}', last_seen_at = now()
  WHERE id_hash = ${SESSION_HASH} AND user_id = '${U}' AND expires_at > now() AND absolute_expires_at > now()`;
const sessionDestroy = `DELETE FROM sessions WHERE id_hash = ${SESSION_HASH}`;
const sessionAbsent = async (owner: pg.Client): Promise<string | null> => {
  const { rowCount } = await owner.query(`SELECT 1 FROM sessions WHERE id_hash = ${SESSION_HASH}`);
  return rowCount === 0 ? null : 'session row exists after logout (resurrected)';
};

/** READ COMMITTED: the given outcome. REPEATABLE READ: the loser gets 40001. */
const rcOr40001 = (iso: Isolation, rcOutcome: Outcome): Outcome =>
  iso === 'READ COMMITTED' ? rcOutcome : '40001';

const st = (s: 'A' | 'B', label: string, sql: string, decide?: Decide): Step =>
  decide ? { s, label, sql, decide } : { s, label, sql };

export function scenarios(iso: Isolation, ref: RefMode): Scenario[] {
  const list: Scenario[] = [
    {
      id: 'D1',
      what: 'approval holds VERSION; raw archive takes ASSET; approval then needs ASSET',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st(
          'A',
          'lock version (as UPDATE does)',
          `SELECT 1 FROM character_versions WHERE id = '${V1}' FOR NO KEY UPDATE`,
        ),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'archive X', archiveX),
        st('A', 'approve V1', approveVersion(V1)),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: rcOr40001(iso, 'AC010'), B: 'commit' },
    },
    {
      id: 'D2',
      what: 'raw archive holds ASSET; raw approval arrives',
      steps: [
        st('B', 'BEGIN', begin(iso)),
        st('B', 'archive X', archiveX),
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve V1', approveVersion(V1)),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: rcOr40001(iso, 'AC010'), B: 'commit' },
    },
    {
      id: 'D3',
      what: 'raw approval holds ASSETS; raw archive arrives',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'archive X', archiveX),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'AC008') },
    },
    {
      id: 'D4',
      what: 'raw archive holds ASSET; SERVICE approval locks version, parent, then assets',
      steps: [
        st('B', 'BEGIN', begin(iso)),
        st('B', 'archive X', archiveX),
        st('A', 'BEGIN', begin(iso)),
        st('A', 'svc lock version', svcLockVersion(V1)),
        st('A', 'svc lock parent', svcLockParent(C)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: rcOr40001(iso, 'ASSET_ARCHIVED'), B: 'commit' },
    },
    {
      id: 'D5',
      what: 'SERVICE approval holds ASSETS; raw archive arrives',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'svc lock version', svcLockVersion(V1)),
        st('A', 'svc lock parent', svcLockParent(C)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'archive X', archiveX),
        st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'AC008') },
    },
    {
      id: 'D6',
      what: 'SERVICE archive holds ASSET (checked unused); SERVICE approval arrives',
      steps: [
        st('B', 'BEGIN', begin(iso)),
        st('B', 'svc lock asset', svcLockAsset),
        st('B', 'svc usage check', svcUsage, svcDecideUsage),
        st('A', 'BEGIN', begin(iso)),
        st('A', 'svc lock version', svcLockVersion(V1)),
        st('A', 'svc lock parent', svcLockParent(C)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('B', 'archive X', archiveX),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: rcOr40001(iso, 'ASSET_ARCHIVED'), B: 'commit' },
    },
    {
      id: 'D7',
      what: 'SERVICE approval of V1 holds version+PARENT; RAW approval of V2 (same parent, shared assets)',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'svc lock version', svcLockVersion(V1)),
        st('A', 'svc lock parent', svcLockParent(C)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve V2', approveVersion(V2)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', movePointer(C, V2)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      // RC: B waits for A, then approves V2 forward of V1. RR: B's parent lock meets A's committed
      // pointer update -> 40001.
      expect: { A: 'commit', B: rcOr40001(iso, 'commit') },
    },
    {
      id: 'D8',
      what: 'two RAW approvals on different parents sharing assets (multi-row lock order)',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve W1', approveVersion(W1)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C2, W1)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', movePointer(C, V1)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'commit') },
    },
    {
      id: 'C3',
      what: 'RAW approvals race out of order (V2 first, then V1): V1 must not become the master',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve V2', approveVersion(V2)),
        st('A', 'move pointer', movePointer(C, V2)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve V1', approveVersion(V1)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', movePointer(C, V1)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'AC003') },
    },
    {
      id: 'C4',
      what: 'the same version approved twice with the SERVICE algorithm: the second is rejected',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'svc lock version', svcLockVersion(V1), svcDecideDraft),
        st('A', 'svc lock parent', svcLockParent(C)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'svc lock version', svcLockVersion(V1), svcDecideDraft),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'svc lock parent', svcLockParent(C)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'ALREADY_APPROVED') },
    },
  ];

  if (ref === 'primary') {
    list.push(
      {
        id: 'C2',
        what: 'link insert races an in-flight approval of the same version: the link is rejected',
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'approve V1', approveVersion(V1)),
          st('A', 'move pointer', movePointer(C, V1)),
          st('B', 'BEGIN', begin(iso)),
          st(
            'B',
            'link Y to V1',
            `INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES ('${P}', '${V1}', '${Y}')`,
          ),
          st('A', 'COMMIT', 'COMMIT'),
          st('B', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: rcOr40001(iso, 'AC002') },
      },
      {
        id: 'O1',
        what: 'two RAW owner demotions; both deferred owner checks fired while both txns are open',
        // SET CONSTRAINTS ALL IMMEDIATE runs the commit-time owner trigger now, so the trigger's
        // lock acquisitions overlap deterministically (they would otherwise run inside COMMIT).
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'demote U', demote(U)),
          st('B', 'BEGIN', begin(iso)),
          st('B', 'demote U2', demote(U2)),
          st('A', 'owner check now', 'SET CONSTRAINTS ALL IMMEDIATE'),
          st('B', 'owner check now', 'SET CONSTRAINTS ALL IMMEDIATE'),
          st('A', 'COMMIT', 'COMMIT'),
          st('B', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: rcOr40001(iso, 'AC007') },
      },
      {
        id: 'O2',
        what: 'SERVICE demotion (member -> project -> count) vs RAW demotion',
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'demote U', demote(U)),
          st('A', 'svc lock project', svcLockProject),
          st('A', 'svc count owners', svcCountOwners, svcDecideOwners),
          st('B', 'BEGIN', begin(iso)),
          st('B', 'demote U2', demote(U2)),
          st('B', 'COMMIT', 'COMMIT'),
          st('A', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: rcOr40001(iso, 'AC007') },
      },
      {
        id: 'O3',
        what: 'two SERVICE demotions overlapping',
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'demote U', demote(U)),
          st('A', 'svc lock project', svcLockProject),
          st('B', 'BEGIN', begin(iso)),
          st('B', 'demote U2', demote(U2)),
          st('B', 'svc lock project', svcLockProject),
          st('A', 'svc count owners', svcCountOwners, svcDecideOwners),
          st('A', 'COMMIT', 'COMMIT'),
          st('B', 'svc count owners', svcCountOwners, svcDecideOwners),
          st('B', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: rcOr40001(iso, 'LAST_OWNER') },
      },
      {
        id: 'O4',
        what: 'two RAW owner demotions, plain COMMITs (sequential commit order)',
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'demote U', demote(U)),
          st('B', 'BEGIN', begin(iso)),
          st('B', 'demote U2', demote(U2)),
          st('A', 'COMMIT', 'COMMIT'),
          st('B', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: rcOr40001(iso, 'AC007') },
        overlapOptional: true,
      },
    );
  }

  // The session store runs single autocommit statements at READ COMMITTED (§5.3.1).
  if (ref === 'primary' && iso === 'READ COMMITTED') {
    list.push(
      {
        id: 'S1',
        what: 'logout DELETE in flight while a late set() UPDATE arrives: the row stays deleted',
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'destroy', sessionDestroy),
          st('B', 'set()', sessionSet),
          st('A', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: 'open' },
        check: sessionAbsent,
      },
      {
        id: 'S2',
        what: 'set() UPDATE in flight while logout DELETE arrives: the row is deleted',
        steps: [
          st('A', 'BEGIN', begin(iso)),
          st('A', 'set()', sessionSet),
          st('B', 'destroy', sessionDestroy),
          st('A', 'COMMIT', 'COMMIT'),
        ],
        expect: { A: 'commit', B: 'open' },
        check: sessionAbsent,
      },
      {
        id: 'S3',
        what: 'logout committed, then a late set(): matches 0 rows, no resurrection',
        steps: [st('A', 'destroy', sessionDestroy), st('B', 'set()', sessionSet)],
        expect: { A: 'open', B: 'open' },
        overlapOptional: true,
        check: sessionAbsent,
      },
    );
  }
  return list;
}
