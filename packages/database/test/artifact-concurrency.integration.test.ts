// Deterministic two-session lock-boundary scenarios for M3 approvals, edits and jobs (M3 design
// package §4.3), on the same harness as the M1 matrix. Each scenario asserts both sessions' exact
// outcome, that no session deadlocked (40P01 on a protocol path is a defect), that the schedule
// really blocked, and the M3 invariants afterwards. Sessions run as acf_app.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { commit, connect, truncateAll } from './support/db.js';
import { runSchedule, type Decide, type Outcome, type Step } from './support/lock-matrix.js';

type Isolation = 'READ COMMITTED' | 'REPEATABLE READ';

const U = '00000000-0000-7000-8000-000000000001';
const P = '10000000-0000-7000-8000-000000000001';
const CI = '40000000-0000-7000-8000-000000000001';
const PROV = '50000000-0000-7000-8000-000000000001';
const MODEL = '51000000-0000-7000-8000-000000000001';
const RUN = '60000000-0000-7000-8000-000000000001';
const JOB = '61000000-0000-7000-8000-000000000001';
const S1 = '62000000-0000-7000-8000-000000000001'; // approved, pointer
const S2 = '62000000-0000-7000-8000-000000000002'; // pending
const S3 = '62000000-0000-7000-8000-000000000003'; // pending
const S4 = '62000000-0000-7000-8000-000000000004'; // created by an edit in a scenario
const SB1 = '63000000-0000-7000-8000-000000000001'; // pending storyboard of S1

let migrator: pg.Client;
let app: pg.Client;

async function seed(): Promise<void> {
  await truncateAll(migrator);
  await app.query(`INSERT INTO users (id, email, display_name, password_hash, updated_at)
    VALUES ('${U}', 'o@example.test', 'O', 'x', now())`);
  await commit(
    app,
    `INSERT INTO projects (id, name, slug, default_language, timezone, created_by_id, updated_at)
       VALUES ('${P}', 'P', 'p', 'vi', 'UTC', '${U}', now());
     INSERT INTO project_members (project_id, user_id, role, updated_at) VALUES ('${P}', '${U}', 'owner', now())`,
  );
  await app.query(`INSERT INTO content_items (id, project_id, title, format, target_duration_seconds, aspect_ratio,
      language, brief, created_by_id, updated_at)
    VALUES ('${CI}', '${P}', 'C', 'short_video', 30, '9:16', 'vi', '{}', '${U}', now())`);
  await app.query(
    `INSERT INTO ai_providers (id, key, name, kind, updated_at) VALUES ('${PROV}', 'mock', 'M', 'mock', now())`,
  );
  await app.query(`INSERT INTO ai_models (id, provider_id, model_key, display_name, quality_tier, updated_at)
    VALUES ('${MODEL}', '${PROV}', 'mock/echo', 'Echo', 'economy', now())`);
  await app.query(`INSERT INTO production_runs (id, project_id, content_item_id, requested_by_id, updated_at)
    VALUES ('${RUN}', '${P}', '${CI}', '${U}', now())`);
  await app.query(`INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, active_key,
      idempotency_key, execution_key, input, previous_content_status, prompt_template_id, model_id, requested_by_id, updated_at)
    VALUES ('${JOB}', '${P}', '${CI}', '${RUN}', 'script_generation', '${CI}:script_generation', 'k', '${'a'.repeat(64)}',
      '{}', 'draft', 'script.v1', '${MODEL}', '${U}', now())`);
  await app.query(`INSERT INTO script_versions (id, project_id, content_item_id, version, source, generation_job_id, schema_version, content)
    VALUES ('${S1}', '${P}', '${CI}', 1, 'generated', '${JOB}', 1, '{}')`);
  for (const [id, v] of [
    [S2, 2],
    [S3, 3],
  ] as const) {
    await app.query(`INSERT INTO script_versions (id, project_id, content_item_id, version, source, based_on_version_id, schema_version, content, created_by_id)
      VALUES ('${id}', '${P}', '${CI}', ${String(v)}, 'edited', '${S1}', 1, '{}', '${U}')`);
  }
  await app.query(
    `UPDATE script_versions SET status = 'approved', reviewed_by_id = '${U}', reviewed_at = now() WHERE id = '${S1}'`,
  );
  await app.query(
    `UPDATE content_items SET approved_script_version_id = '${S1}' WHERE id = '${CI}'`,
  );
  await app.query(`UPDATE generation_jobs SET status = 'succeeded', active_key = NULL, completed_at = now(),
    result_script_version_id = '${S1}' WHERE id = '${JOB}'`);
  await app.query(`INSERT INTO storyboard_versions (id, project_id, content_item_id, script_version_id, version, source,
      generation_job_id, schema_version, total_duration_seconds)
    VALUES ('${SB1}', '${P}', '${CI}', '${S1}', 1, 'generated', '${JOB}', 1, 30)`);
}

/** The M3 invariants (design §4.3, §6.3), each a count of violating rows. */
async function invariants(): Promise<Record<string, number>> {
  const count = async (sql: string) =>
    Number((await migrator.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
  return {
    scriptPointerNotApproved:
      await count(`SELECT count(*) AS n FROM content_items c JOIN script_versions s
      ON s.id = c.approved_script_version_id WHERE s.status <> 'approved'`),
    storyboardPointerStale:
      await count(`SELECT count(*) AS n FROM content_items c JOIN storyboard_versions b
      ON b.id = c.approved_storyboard_version_id WHERE b.status <> 'approved'
      OR b.script_version_id IS DISTINCT FROM c.approved_script_version_id`),
    approvedStoryboardOfUnapprovedScript:
      await count(`SELECT count(*) AS n FROM storyboard_versions b
      JOIN script_versions s ON s.id = b.script_version_id WHERE b.status = 'approved' AND s.status <> 'approved'`),
    activeJobsPerItemKindAboveOne:
      await count(`SELECT count(*) AS n FROM (SELECT content_item_id, kind FROM generation_jobs
      WHERE status IN ('queued', 'running') GROUP BY 1, 2 HAVING count(*) > 1) x`),
  };
}

const begin = (iso: Isolation) => `BEGIN ISOLATION LEVEL ${iso}`;
const st = (s: 'A' | 'B', label: string, sql: string, decide?: Decide): Step =>
  decide ? { s, label, sql, decide } : { s, label, sql };
const rcOr40001 = (iso: Isolation, rc: Outcome): Outcome =>
  iso === 'READ COMMITTED' ? rc : '40001';
const approve = (table: string, id: string) =>
  `UPDATE ${table} SET status = 'approved', reviewed_by_id = '${U}', reviewed_at = now() WHERE id = '${id}'`;
/** Service: lock the parent after the version (global order) and refuse archived items. */
const lockParent = `SELECT archived_at FROM content_items WHERE id = '${CI}' FOR NO KEY UPDATE`;
const notArchived: Decide = (rows) => (rows[0]?.['archived_at'] ? 'ARCHIVED' : 'ok');
const moveScriptPointer = (id: string) =>
  `UPDATE content_items SET approved_script_version_id = '${id}', approved_storyboard_version_id = NULL WHERE id = '${CI}'`;
const newJob = (id: string) =>
  `INSERT INTO generation_jobs (id, project_id, content_item_id, production_run_id, kind, active_key, idempotency_key,
     execution_key, input, previous_content_status, prompt_template_id, model_id, requested_by_id, updated_at)
   VALUES ('${id}', '${P}', '${CI}', '${RUN}', 'storyboard_generation', '${CI}:storyboard_generation', 'k-${id}',
     '${'b'.repeat(64)}', '{}', 'script_review', 'storyboard.v1', '${MODEL}', '${U}', now())`;

interface Scenario {
  readonly id: string;
  readonly what: string;
  readonly steps: readonly Step[];
  readonly expect: { readonly A: Outcome; readonly B: Outcome };
  readonly check?: () => Promise<string | null>;
}

function scenarios(iso: Isolation): Scenario[] {
  return [
    {
      id: 'SA1',
      what: 'two editors approve different script versions',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve S2', approve('script_versions', S2)),
        st('A', 'lock parent', lockParent, notArchived),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve S3', approve('script_versions', S3)),
        st('B', 'lock parent', lockParent, notArchived),
        st('A', 'move pointer', moveScriptPointer(S2)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', moveScriptPointer(S3)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'commit') },
    },
    {
      id: 'SA2',
      what: 'two editors approve the same version',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve S2', approve('script_versions', S2)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve S2', approve('script_versions', S2)),
        st('A', 'lock parent', lockParent, notArchived),
        st('A', 'move pointer', moveScriptPointer(S2)),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'AC012') },
    },
    {
      id: 'SA3',
      what: 'storyboard approval holds the parent; a new script approval arrives and clears the storyboard pointer',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve SB1', approve('storyboard_versions', SB1)),
        st('A', 'lock parent', lockParent, notArchived),
        st(
          'A',
          'set storyboard pointer',
          `UPDATE content_items SET approved_storyboard_version_id = '${SB1}' WHERE id = '${CI}'`,
        ),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve S2', approve('script_versions', S2)),
        st('B', 'lock parent', lockParent, notArchived),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', moveScriptPointer(S2)),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'commit') },
      check: async () => {
        if (iso === 'REPEATABLE READ') return null;
        const { rows } = await migrator.query<{ s: string; b: string | null }>(
          `SELECT approved_script_version_id AS s, approved_storyboard_version_id AS b FROM content_items WHERE id = '${CI}'`,
        );
        return rows[0]?.s === S2 && rows[0].b === null
          ? null
          : `pointers ${JSON.stringify(rows[0])}`;
      },
    },
    {
      id: 'SA4',
      what: 'a new script approval holds the parent; approving the old storyboard arrives (stale)',
      steps: [
        st('B', 'BEGIN', begin(iso)),
        st('B', 'approve S2', approve('script_versions', S2)),
        st('B', 'lock parent', lockParent, notArchived),
        st('B', 'move pointer', moveScriptPointer(S2)),
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve SB1 (trigger reads parent)', approve('storyboard_versions', SB1)),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: rcOr40001(iso, 'AC013'), B: 'commit' },
    },
    {
      id: 'SA5',
      what: 'approval holds version and parent; an edit allocating the next version number arrives',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve S2', approve('script_versions', S2)),
        st('A', 'lock parent', lockParent, notArchived),
        st('A', 'move pointer', moveScriptPointer(S2)),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'lock parent (allocate version)', lockParent, notArchived),
        st('A', 'COMMIT', 'COMMIT'),
        st(
          'B',
          'insert edit S4 based on S2',
          `INSERT INTO script_versions (id, project_id, content_item_id, version, source, based_on_version_id, schema_version, content, created_by_id)
           SELECT '${S4}', '${P}', '${CI}', max(version) + 1, 'edited', '${S2}', 1, '{}', '${U}' FROM script_versions WHERE content_item_id = '${CI}'`,
        ),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: rcOr40001(iso, 'commit') },
    },
    {
      id: 'SA6',
      what: 'archiving the content item holds the parent; an approval arrives',
      steps: [
        st('B', 'BEGIN', begin(iso)),
        st('B', 'archive item', `UPDATE content_items SET archived_at = now() WHERE id = '${CI}'`),
        st('A', 'BEGIN', begin(iso)),
        st('A', 'approve S2', approve('script_versions', S2)),
        st('A', 'lock parent', lockParent, notArchived),
        st('B', 'COMMIT', 'COMMIT'),
        st('A', 'move pointer', moveScriptPointer(S2)),
        st('A', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: rcOr40001(iso, 'ARCHIVED'), B: 'commit' },
    },
    {
      id: 'SA7',
      what: 'two storyboard jobs for the same item start concurrently (one active job per kind)',
      steps: [
        st('A', 'BEGIN', begin(iso)),
        st('A', 'insert job', newJob('61000000-0000-7000-8000-0000000000a1')),
        st('B', 'BEGIN', begin(iso)),
        st('B', 'insert job', newJob('61000000-0000-7000-8000-0000000000b1')),
        st('A', 'COMMIT', 'COMMIT'),
        st('B', 'COMMIT', 'COMMIT'),
      ],
      expect: { A: 'commit', B: '23505' },
    },
  ];
}

beforeAll(async () => {
  migrator = await connect('migrator');
  app = await connect('app');
});

afterAll(async () => {
  await app.end();
  await migrator.end();
});

describe.each(['READ COMMITTED', 'REPEATABLE READ'] as const)('%s', (iso) => {
  it.each(scenarios(iso).map((sc) => [sc.id, sc] as const))('%s', async (_id, sc) => {
    await seed();
    const result = await runSchedule(migrator, inject('databaseUrls').appUrl, sc.steps);
    const context = `${sc.id} (${sc.what})\ntrace: ${result.trace.join(' | ')}`;
    expect([result.A, result.B], context).not.toContain('40P01');
    expect({ A: result.A, B: result.B }, context).toEqual(sc.expect);
    expect(result.blockedSteps.length, `schedule never blocked: ${context}`).toBeGreaterThan(0);
    expect(await invariants(), context).toEqual({
      scriptPointerNotApproved: 0,
      storyboardPointerStale: 0,
      approvedStoryboardOfUnapprovedScript: 0,
      activeJobsPerItemKindAboveOne: 0,
    });
    if (sc.check) expect(await sc.check(), context).toBeNull();
  });
});
