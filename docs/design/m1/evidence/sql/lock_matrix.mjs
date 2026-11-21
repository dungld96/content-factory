// Deterministic lock-boundary concurrency matrix (archive vs approval, owner changes).
//
// Two sessions (A, B) are driven step by step. Instead of fixed sleeps, each step waits until its
// statement has either COMPLETED or is observed BLOCKED on a lock (pg_blocking_pids(pid) <> {}),
// so the interleaving at lock-acquisition boundaries is reproduced exactly on every run.
// Every statement's outcome and PostgreSQL SQLSTATE are recorded and asserted.
// An unexpected 40P01 (deadlock) is always a FAILURE.
//
// usage: node lock_matrix.mjs <generated-tables.sql> <triggers.sql> <mode>
//   mode = expect-pass       : assert the exact expected outcome of every scenario (current design)
//          expect-deadlock   : negative control; PASS only if >= 1 scenario hits 40P01
//          expect-violation  : negative control; PASS only if >= 1 scenario breaks an invariant
// Requires the `pg` package (run-all.sh runs this from the session spike install).
import { readFileSync } from 'node:fs';
import pg from 'pg';

const [, , tablesSql, triggersSql, mode = 'expect-pass'] = process.argv;
const OWNER = { host: 'localhost', port: 5432, user: 'acf', password: process.env.PGPASSWORD_OWNER ?? 'acf_local_dev_only' };
const APP = { host: 'localhost', port: 5432, user: 'acf_app', password: 'acf_app_spike' };
const DB = 'acf_design_spike';
const STEP_TIMEOUT_MS = 8000; // > deadlock_timeout (1s): a deadlock always resolves within a step

const U = '00000000-0000-7000-8000-000000000001';
const U2 = '00000000-0000-7000-8000-000000000002';
const P = '10000000-0000-7000-8000-000000000001';
const X = '20000000-0000-7000-8000-00000000000a';
const Y = '20000000-0000-7000-8000-00000000000b';
const C = '30000000-0000-7000-8000-000000000001';
const C2 = '30000000-0000-7000-8000-000000000002';
const V1 = '31000000-0000-7000-8000-000000000001';
const V2 = '31000000-0000-7000-8000-000000000002';
const W1 = '32000000-0000-7000-8000-000000000001';

// ------------------------------------------------------------------ database setup
async function setupDatabase() {
  const admin = new pg.Client({ ...OWNER, database: 'acf' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acf_app') THEN
      CREATE ROLE acf_app LOGIN PASSWORD 'acf_app_spike' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$`);
  await admin.end();
  const owner = new pg.Client({ ...OWNER, database: DB });
  await owner.connect();
  await owner.query(readFileSync(tablesSql, 'utf8'));
  await owner.query(readFileSync(triggersSql, 'utf8'));
  await owner.query(`GRANT CONNECT ON DATABASE ${DB} TO acf_app; GRANT USAGE ON SCHEMA public TO acf_app;
                     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acf_app`);
  return owner;
}

async function seed(owner, ref) {
  await owner.query(`TRUNCATE users, sessions, projects, project_members, channels, characters, character_versions,
    character_version_assets, environments, environment_versions, environment_version_assets, assets, content_items CASCADE`);
  await owner.query(`INSERT INTO users (id,email,display_name,password_hash,updated_at) VALUES
    ('${U}','o1@x.test','O1','x',now()), ('${U2}','o2@x.test','O2','x',now())`);
  await owner.query(`BEGIN;
    INSERT INTO projects (id,name,slug,default_language,timezone,created_by_id,updated_at) VALUES ('${P}','P','p','vi','UTC','${U}',now());
    INSERT INTO project_members (project_id,user_id,role,updated_at) VALUES ('${P}','${U}','owner',now()), ('${P}','${U2}','owner',now());
    COMMIT`);
  await owner.query(`INSERT INTO assets (id,project_id,asset_type,source_type,storage_key,mime_type,size_bytes,checksum_sha256,created_by_id,updated_at) VALUES
    ('${X}','${P}','reference','upload','k/x','image/png',1,repeat('a',64),'${U}',now()),
    ('${Y}','${P}','reference','upload','k/y','image/png',1,repeat('b',64),'${U}',now())`);
  await owner.query(`INSERT INTO characters (id,project_id,name,slug,created_by_id,updated_at) VALUES
    ('${C}','${P}','C','c','${U}',now()), ('${C2}','${P}','C2','c2','${U}',now())`);
  const primary = ref === 'primary';
  await owner.query(`INSERT INTO character_versions (id,project_id,character_id,version,description,primary_asset_id,created_by_id,updated_at) VALUES
    ('${V1}','${P}','${C}',1,'v1',${primary ? `'${X}'` : 'NULL'},'${U}',now()),
    ('${V2}','${P}','${C}',2,'v2',${primary ? `'${X}'` : 'NULL'},'${U}',now()),
    ('${W1}','${P}','${C2}',1,'w1',${primary ? `'${X}'` : 'NULL'},'${U}',now())`);
  if (!primary) {
    // link mode: every version links BOTH assets (exercises multi-row lock ordering)
    for (const v of [V1, V2, W1]) {
      await owner.query(`INSERT INTO character_version_assets (project_id,character_version_id,asset_id) VALUES ('${P}','${v}','${Y}'), ('${P}','${v}','${X}')`);
    }
  }
}

// ------------------------------------------------------------------ session driver
class Session {
  constructor(name) { this.name = name; this.failed = null; this.pending = null; this.log = []; this.outcome = null; }
  async open() { this.client = new pg.Client({ ...APP, database: DB }); await this.client.connect();
    this.pid = (await this.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; }
  start(label, sql) {
    const entry = { label, state: 'running' };
    this.log.push(entry);
    this.pending = this.client.query(sql).then(
      (res) => { entry.state = 'ok'; entry.rows = res.rows ?? (Array.isArray(res) ? res.at(-1).rows : []); return entry; },
      (err) => { entry.state = 'error'; entry.code = err.code; entry.message = err.message; this.failed ??= err.code; return entry; });
    this.pending.finally(() => { this.pending = null; });
    return entry;
  }
  async close() { try { await this.client.query('ROLLBACK'); } catch {} await this.client.end(); }
}

async function isBlocked(inspector, pid) {
  const r = await inspector.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS b', [pid]);
  return r.rows[0].b;
}

/** Waits until the step settles or is observed blocked. Returns 'done' | 'blocked' | 'timeout'. */
async function settleOrBlock(inspector, s, entry) {
  const t0 = Date.now();
  while (Date.now() - t0 < STEP_TIMEOUT_MS) {
    if (entry.state !== 'running') return 'done';
    if (await isBlocked(inspector, s.pid)) return 'blocked';
    await new Promise((r) => setTimeout(r, 15));
  }
  return 'timeout';
}

async function runSchedule(inspector, steps) {
  const S = { A: new Session('A'), B: new Session('B') };
  await S.A.open(); await S.B.open();
  const trace = [];
  const backlog = { A: [], B: [] }; // steps waiting because their session is blocked
  const busy = (s) => s.log.at(-1)?.state === 'running';
  const fmt = (name, e) => `${name}:${e.label}→${e.state}${e.code ? '(' + e.code + ')' : ''}`;

  async function execute(name, step) {
    const s = S[name];
    if (s.failed) { trace.push(`${name}:${step.label}→skipped(txn aborted ${s.failed})`); return; }
    if (s.outcome) { trace.push(`${name}:${step.label}→skipped(${s.outcome})`); return; }
    const entry = s.start(step.label, typeof step.sql === 'function' ? step.sql() : step.sql);
    const r = await settleOrBlock(inspector, s, entry);
    if (r === 'done') {
      trace.push(fmt(name, entry));
      if (entry.state === 'ok' && step.decide) await decide(name, step, entry);
    } else {
      trace.push(`${name}:${step.label}→${r}`);
      entry.decideWith = step.decide; // apply the service decision once it unblocks
    }
  }
  async function decide(name, step, entry) {
    const d = (step.decide ?? entry.decideWith)(entry.rows);
    if (d !== 'ok') { S[name].outcome = d; await S[name].client.query('ROLLBACK'); trace.push(`${name}: service decision ${d} → ROLLBACK`); }
  }
  /** Runs backlogged steps of every session that is no longer blocked. */
  async function pump() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const name of ['A', 'B']) {
        const s = S[name];
        const last = s.log.at(-1);
        if (last && last.state !== 'running' && last.reported !== true && last.wasBlocked) {
          last.reported = true; trace.push(fmt(name, last) + ' (unblocked)');
          if (last.state === 'ok' && last.decideWith) await decide(name, {}, last);
        }
        if (!busy(s) && backlog[name].length > 0) { await execute(name, backlog[name].shift()); progressed = true; }
      }
    }
  }
  for (const step of steps) {
    const s = S[step.s];
    if (busy(s) || backlog[step.s].length > 0) { s.log.at(-1).wasBlocked = true; backlog[step.s].push(step); }
    else await execute(step.s, step);
    // give a just-released session a moment to finish, then run what it was waiting to do
    for (const n of ['A', 'B']) { const l = S[n].log.at(-1); if (l?.state === 'running') { l.wasBlocked = true; await settleOrBlock(inspector, S[n], l); } }
    await pump();
  }
  const t0 = Date.now(); // drain: wait for blocked statements to finish (or time out)
  while ((busy(S.A) || busy(S.B) || backlog.A.length || backlog.B.length) && Date.now() - t0 < STEP_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 15)); await pump();
  }
  const result = {};
  for (const [k, s] of Object.entries(S)) {
    if (busy(s) || backlog[k].length) { result[k] = 'timeout'; trace.push(`${k}: TIMEOUT (still blocked)`); }
    else {
      const committed = s.log.some((e) => e.label === 'COMMIT' && e.state === 'ok');
      result[k] = s.failed ?? s.outcome ?? (committed ? 'commit' : 'open');
    }
    await s.close();
  }
  return { result, trace };
}

// ------------------------------------------------------------------ SQL building blocks
const begin = (iso) => `BEGIN ISOLATION LEVEL ${iso}`;
const approveVersion = (v) => `UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='${U}' WHERE id='${v}'`;
const movePointer = (c, v) => `UPDATE characters SET master_version_id='${v}' WHERE id='${c}'`;
const archiveX = `UPDATE assets SET archived_at = now() WHERE id='${X}'`;
// service approval, lock order version -> parent -> assets (id order)
const svcLockVersion = (v) => `SELECT id FROM character_versions WHERE id='${v}' FOR UPDATE`;
const svcLockParent = (c) => `SELECT id FROM characters WHERE id='${c}' FOR NO KEY UPDATE`;
const svcLockAssets = (v) => `SELECT id, archived_at FROM assets WHERE id IN (
    SELECT primary_asset_id FROM character_versions WHERE id='${v}'
    UNION SELECT asset_id FROM character_version_assets WHERE character_version_id='${v}') ORDER BY id FOR NO KEY UPDATE`;
const svcDecideAssets = (rows) => (rows.some((r) => r.archived_at !== null) ? 'ASSET_ARCHIVED' : 'ok');
// service archive: lock the asset, then check usages
const svcLockAsset = `SELECT id FROM assets WHERE id='${X}' FOR NO KEY UPDATE`;
const svcUsage = `SELECT count(*)::int AS n FROM character_versions WHERE status='approved' AND (primary_asset_id='${X}'
    OR id IN (SELECT character_version_id FROM character_version_assets WHERE asset_id='${X}'))`;
const svcDecideUsage = (rows) => (rows[0].n > 0 ? 'ASSET_IN_USE' : 'ok');
// service last-owner: member row -> project row (write) -> count
const demote = (u) => `UPDATE project_members SET role='editor' WHERE project_id='${P}' AND user_id='${u}'`;
const svcLockProject = `UPDATE projects SET updated_at = updated_at WHERE id='${P}'`;
const svcCountOwners = `SELECT count(*)::int AS n FROM project_members WHERE project_id='${P}' AND role='owner'`;
const svcDecideOwners = (rows) => (rows[0].n === 0 ? 'LAST_OWNER' : 'ok');

const LOSER = { 'READ COMMITTED': null, 'REPEATABLE READ': '40001' };
const rc = (iso, rcValue) => (iso === 'READ COMMITTED' ? rcValue : LOSER[iso]);

// Each scenario: steps + expected {A, B} final outcome (current design) + invariant checks.
function scenarios(iso, ref) {
  const st = (s, label, sql, decide) => ({ s, label, sql, decide });
  return [
    { id: 'D1', what: 'approval holds VERSION; raw archive takes ASSET; approval then needs ASSET',
      steps: [st('A', 'BEGIN', begin(iso)), st('A', 'lock version (as UPDATE does)', `SELECT 1 FROM character_versions WHERE id='${V1}' FOR NO KEY UPDATE`),
        st('B', 'BEGIN', begin(iso)), st('B', 'archive X', archiveX),
        st('A', 'approve V1', approveVersion(V1)), st('B', 'COMMIT', 'COMMIT'),
        st('A', 'move pointer', movePointer(C, V1)), st('A', 'COMMIT', 'COMMIT')],
      expect: { A: rc(iso, 'AC010'), B: 'commit' } },
    { id: 'D2', what: 'raw archive holds ASSET; raw approval arrives',
      steps: [st('B', 'BEGIN', begin(iso)), st('B', 'archive X', archiveX),
        st('A', 'BEGIN', begin(iso)), st('A', 'approve V1', approveVersion(V1)), st('B', 'COMMIT', 'COMMIT'),
        st('A', 'move pointer', movePointer(C, V1)), st('A', 'COMMIT', 'COMMIT')],
      expect: { A: rc(iso, 'AC010'), B: 'commit' } },
    { id: 'D3', what: 'raw approval holds ASSETS; raw archive arrives',
      steps: [st('A', 'BEGIN', begin(iso)), st('A', 'approve V1', approveVersion(V1)), st('A', 'move pointer', movePointer(C, V1)),
        st('B', 'BEGIN', begin(iso)), st('B', 'archive X', archiveX), st('A', 'COMMIT', 'COMMIT'), st('B', 'COMMIT', 'COMMIT')],
      expect: { A: 'commit', B: rc(iso, 'AC008') } },
    { id: 'D4', what: 'raw archive holds ASSET; SERVICE approval locks version, parent, then assets',
      steps: [st('B', 'BEGIN', begin(iso)), st('B', 'archive X', archiveX),
        st('A', 'BEGIN', begin(iso)), st('A', 'svc lock version', svcLockVersion(V1)), st('A', 'svc lock parent', svcLockParent(C)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets), st('B', 'COMMIT', 'COMMIT'),
        st('A', 'approve V1', approveVersion(V1)), st('A', 'move pointer', movePointer(C, V1)), st('A', 'COMMIT', 'COMMIT')],
      expect: { A: rc(iso, 'ASSET_ARCHIVED'), B: 'commit' } },
    { id: 'D5', what: 'SERVICE approval holds ASSETS; raw archive arrives',
      steps: [st('A', 'BEGIN', begin(iso)), st('A', 'svc lock version', svcLockVersion(V1)), st('A', 'svc lock parent', svcLockParent(C)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('B', 'BEGIN', begin(iso)), st('B', 'archive X', archiveX),
        st('A', 'approve V1', approveVersion(V1)), st('A', 'move pointer', movePointer(C, V1)), st('A', 'COMMIT', 'COMMIT'), st('B', 'COMMIT', 'COMMIT')],
      expect: { A: 'commit', B: rc(iso, 'AC008') } },
    { id: 'D6', what: 'SERVICE archive holds ASSET (checked unused); SERVICE approval arrives',
      steps: [st('B', 'BEGIN', begin(iso)), st('B', 'svc lock asset', svcLockAsset), st('B', 'svc usage check', svcUsage, svcDecideUsage),
        st('A', 'BEGIN', begin(iso)), st('A', 'svc lock version', svcLockVersion(V1)), st('A', 'svc lock parent', svcLockParent(C)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets),
        st('B', 'archive X', archiveX), st('B', 'COMMIT', 'COMMIT'),
        st('A', 'approve V1', approveVersion(V1)), st('A', 'move pointer', movePointer(C, V1)), st('A', 'COMMIT', 'COMMIT')],
      expect: { A: rc(iso, 'ASSET_ARCHIVED'), B: 'commit' } },
    { id: 'D7', what: 'SERVICE approval of V1 holds version+PARENT; RAW approval of V2 (same parent, shares assets)',
      steps: [st('A', 'BEGIN', begin(iso)), st('A', 'svc lock version', svcLockVersion(V1)), st('A', 'svc lock parent', svcLockParent(C)),
        st('B', 'BEGIN', begin(iso)), st('B', 'approve V2', approveVersion(V2)),
        st('A', 'svc lock assets', svcLockAssets(V1), svcDecideAssets), st('A', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C, V1)), st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', movePointer(C, V2)), st('B', 'COMMIT', 'COMMIT')],
      // RC: B waits for A, then approves v2 forward of v1. RR: B's parent lock hits A's committed pointer update -> 40001.
      expect: { A: 'commit', B: rc(iso, 'commit') } },
    { id: 'D8', what: 'two RAW approvals on different parents sharing assets (multi-row lock order)',
      steps: [st('A', 'BEGIN', begin(iso)), st('A', 'approve W1', approveVersion(W1)),
        st('B', 'BEGIN', begin(iso)), st('B', 'approve V1', approveVersion(V1)),
        st('A', 'move pointer', movePointer(C2, W1)), st('A', 'COMMIT', 'COMMIT'),
        st('B', 'move pointer', movePointer(C, V1)), st('B', 'COMMIT', 'COMMIT')],
      // RC: B waits on the shared asset rows then proceeds. RR: those rows were written by A -> 40001.
      expect: { A: 'commit', B: rc(iso, 'commit') } },
    ...(ref === 'primary' ? [
      { id: 'O1', what: 'two RAW owner demotions; both deferred owner checks fired while both txns are open',
        // SET CONSTRAINTS ALL IMMEDIATE runs the commit-time owner trigger now, so the trigger's
        // lock acquisitions overlap deterministically (they would otherwise run inside COMMIT).
        steps: [st('A', 'BEGIN', begin(iso)), st('A', 'demote U', demote(U)), st('B', 'BEGIN', begin(iso)), st('B', 'demote U2', demote(U2)),
          st('A', 'owner check now', 'SET CONSTRAINTS ALL IMMEDIATE'), st('B', 'owner check now', 'SET CONSTRAINTS ALL IMMEDIATE'),
          st('A', 'COMMIT', 'COMMIT'), st('B', 'COMMIT', 'COMMIT')],
        expect: { A: 'commit', B: rc(iso, 'AC007') } },
      { id: 'O4', what: 'two RAW owner demotions, plain COMMITs (no overlap required; sequential commit order)',
        steps: [st('A', 'BEGIN', begin(iso)), st('A', 'demote U', demote(U)), st('B', 'BEGIN', begin(iso)), st('B', 'demote U2', demote(U2)),
          st('A', 'COMMIT', 'COMMIT'), st('B', 'COMMIT', 'COMMIT')],
        expect: { A: 'commit', B: rc(iso, 'AC007') }, overlapOptional: true },
      { id: 'O2', what: 'SERVICE demotion (member -> project -> count) vs RAW demotion',
        steps: [st('A', 'BEGIN', begin(iso)), st('A', 'demote U', demote(U)), st('A', 'svc lock project', svcLockProject),
          st('A', 'svc count owners', svcCountOwners, svcDecideOwners),
          st('B', 'BEGIN', begin(iso)), st('B', 'demote U2', demote(U2)), st('B', 'COMMIT', 'COMMIT'), st('A', 'COMMIT', 'COMMIT')],
        expect: { A: 'commit', B: rc(iso, 'AC007') } },
      { id: 'O3', what: 'two SERVICE demotions overlapping',
        steps: [st('A', 'BEGIN', begin(iso)), st('A', 'demote U', demote(U)), st('A', 'svc lock project', svcLockProject),
          st('B', 'BEGIN', begin(iso)), st('B', 'demote U2', demote(U2)), st('B', 'svc lock project', svcLockProject),
          st('A', 'svc count owners', svcCountOwners, svcDecideOwners), st('A', 'COMMIT', 'COMMIT'),
          st('B', 'svc count owners', svcCountOwners, svcDecideOwners), st('B', 'COMMIT', 'COMMIT')],
        expect: { A: 'commit', B: rc(iso, 'LAST_OWNER') } },
    ] : []),
  ];
}

async function invariants(owner) {
  const q = async (sql) => (await owner.query(sql)).rows[0].n;
  return {
    approvedWithArchivedAsset: await q(`SELECT count(*)::int n FROM character_versions v JOIN assets a ON a.archived_at IS NOT NULL
      AND (a.id = v.primary_asset_id OR a.id IN (SELECT asset_id FROM character_version_assets l WHERE l.character_version_id = v.id))
      WHERE v.status = 'approved'`),
    projectsWithoutOwner: await q(`SELECT count(*)::int n FROM projects p WHERE NOT EXISTS
      (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.role = 'owner')`),
    masterNotHighestApproved: await q(`SELECT count(*)::int n FROM characters c WHERE c.master_version_id IS DISTINCT FROM
      (SELECT id FROM character_versions v WHERE v.character_id = c.id AND v.status = 'approved' ORDER BY version DESC LIMIT 1)`),
  };
}

// ------------------------------------------------------------------ main
const owner = await setupDatabase();
const inspector = new pg.Client({ ...OWNER, database: DB });
await inspector.connect();
let failures = 0, deadlocks = 0, violations = 0, total = 0;
const rows = [];
for (const iso of ['READ COMMITTED', 'REPEATABLE READ']) {
  for (const ref of ['primary', 'link']) {
    for (const sc of scenarios(iso, ref)) {
      await seed(owner, ref);
      const { result, trace } = await runSchedule(inspector, sc.steps);
      const inv = await invariants(owner);
      const invOk = Object.values(inv).every((n) => n === 0);
      const sawDeadlock = Object.values(result).includes('40P01');
      const asExpected = result.A === sc.expect.A && result.B === sc.expect.B;
      // Proof that the schedule really overlapped: at least one statement was observed waiting
      // on the other session's lock (pg_blocking_pids). Otherwise the scenario tested nothing.
      const blockedSteps = trace.filter((t) => t.endsWith('→blocked')).map((t) => t.replace('→blocked', ''));
      const overlapped = blockedSteps.length > 0;
      total++;
      if (sawDeadlock) deadlocks++;
      if (!invOk) violations++;
      const pass = mode === 'expect-pass' ? asExpected && invOk && !sawDeadlock && (overlapped || sc.overlapOptional === true) : true;
      if (!pass) failures++;
      rows.push({ id: sc.id, ref, iso, A: result.A, B: result.B, exp: `${sc.expect.A}/${sc.expect.B}`, invOk, sawDeadlock, pass, trace, what: sc.what, inv, blockedSteps, overlapOptional: sc.overlapOptional === true });
    }
  }
}
await inspector.end(); await owner.end();
const admin = new pg.Client({ ...OWNER, database: 'acf' }); await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS ${DB}`); await admin.end();

const pad = (s, n) => String(s).padEnd(n);
console.log(`lock matrix — triggers: ${triggersSql} — mode: ${mode}`);
console.log(pad('scen', 5) + pad('ref', 8) + pad('isolation', 16) + pad('A', 15) + pad('B', 15) + pad('expected A/B', 26) + pad('invariants', 11) + pad('result', 9) + 'observed blocked on lock');
for (const r of rows) {
  const verdict = mode === 'expect-pass' ? (r.pass ? 'PASS' : 'FAIL') : (r.sawDeadlock ? 'DEADLOCK' : !r.invOk ? 'VIOLATION' : '-');
  console.log(pad(r.id, 5) + pad(r.ref, 8) + pad(r.iso, 16) + pad(r.A, 15) + pad(r.B, 15) + pad(r.exp, 26) + pad(r.invOk ? 'ok' : 'BROKEN', 11)
    + pad(verdict + (r.sawDeadlock ? ' 40P01' : ''), 9) + (r.blockedSteps.join('; ') || (r.overlapOptional ? '(none; sequential by design)' : 'NONE (overlap not exercised)')));
  if ((mode === 'expect-pass' && !r.pass) || process.env.TRACE) console.log('      ' + r.what + '\n      trace: ' + r.trace.join(' | ') + '\n      invariants: ' + JSON.stringify(r.inv));
}
console.log(`scenarios: ${total}, deadlocks (40P01): ${deadlocks}, invariant violations: ${violations}, failures: ${failures}`);
const ok = mode === 'expect-pass' ? failures === 0 && deadlocks === 0 && violations === 0
  : mode === 'expect-deadlock' ? deadlocks > 0 : violations > 0;
console.log(`RESULT (${mode}): ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
