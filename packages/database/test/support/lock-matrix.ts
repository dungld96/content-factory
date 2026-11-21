// Deterministic two-session lock-boundary harness (ADR-0011 §5–6). Ported from
// docs/design/m1/evidence/sql/lock_matrix.mjs.
//
// Two sessions (A, B) are driven step by step. Instead of sleeping, each step waits until its
// statement has either COMPLETED or is observed BLOCKED on a lock (pg_blocking_pids), so every
// run reproduces the same interleaving at the same lock boundary. Every statement's outcome and
// SQLSTATE are recorded so tests can assert both sessions' exact final outcome.
import pg from 'pg';

import { sqlStateOf } from './db.js';

export type SessionName = 'A' | 'B';
export type Row = Record<string, unknown>;
/** Service decision on a statement's rows: 'ok' to continue, or an error code to roll back. */
export type Decide = (rows: Row[]) => string;

export interface Step {
  readonly s: SessionName;
  readonly label: string;
  readonly sql: string;
  readonly decide?: Decide;
}

interface Entry {
  readonly label: string;
  state: 'running' | 'ok' | 'error';
  rows: Row[];
  code?: string;
  wasBlocked?: boolean;
  reported?: boolean;
  decideWith?: Decide;
}

/**
 * Final outcome of a session: 'commit', 'open' (no COMMIT step ran), 'timeout', a SQLSTATE
 * (the first error), or a service decision code.
 */
export type Outcome = string;

export interface ScheduleResult {
  readonly A: Outcome;
  readonly B: Outcome;
  readonly trace: readonly string[];
  /** Steps that were observed waiting on the other session's lock. */
  readonly blockedSteps: readonly string[];
}

const STEP_TIMEOUT_MS = 8_000; // > deadlock_timeout (1 s): a deadlock always resolves in a step
const POLL_MS = 15;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Session {
  failed: string | null = null;
  outcome: string | null = null;
  readonly log: Entry[] = [];
  pid = 0;
  private constructor(
    readonly name: SessionName,
    readonly client: pg.Client,
  ) {}

  static async open(name: SessionName, connectionString: string): Promise<Session> {
    const client = new pg.Client({ connectionString });
    await client.connect();
    const session = new Session(name, client);
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    session.pid = rows[0]?.pid ?? 0;
    return session;
  }

  get busy(): boolean {
    return this.log.at(-1)?.state === 'running';
  }

  start(label: string, sql: string): Entry {
    const entry: Entry = { label, state: 'running', rows: [] };
    this.log.push(entry);
    this.client.query<Row>(sql).then(
      (res) => {
        entry.state = 'ok';
        entry.rows = res.rows;
      },
      (error: unknown) => {
        entry.state = 'error';
        entry.code = sqlStateOf(error) ?? 'NO_SQLSTATE';
        this.failed ??= entry.code;
      },
    );
    return entry;
  }

  async close(): Promise<void> {
    try {
      // A still-blocked statement would queue the ROLLBACK behind it; just disconnect then.
      if (!this.busy) await this.client.query('ROLLBACK');
    } catch {
      // Connection already unusable; closing is enough.
    }
    await this.client.end();
  }
}

async function isBlocked(inspector: pg.Client, pid: number): Promise<boolean> {
  const { rows } = await inspector.query<{ b: boolean }>(
    'SELECT cardinality(pg_blocking_pids($1)) > 0 AS b',
    [pid],
  );
  return rows[0]?.b ?? false;
}

async function settleOrBlock(
  inspector: pg.Client,
  session: Session,
  entry: Entry,
): Promise<'done' | 'blocked' | 'timeout'> {
  const started = Date.now();
  while (Date.now() - started < STEP_TIMEOUT_MS) {
    if (entry.state !== 'running') return 'done';
    if (await isBlocked(inspector, session.pid)) return 'blocked';
    await sleep(POLL_MS);
  }
  return 'timeout';
}

/**
 * Runs `steps` across two sessions connected with `connectionString`. `inspector` is a third
 * connection used only to observe lock waits.
 */
export async function runSchedule(
  inspector: pg.Client,
  connectionString: string,
  steps: readonly Step[],
): Promise<ScheduleResult> {
  const sessions: Record<SessionName, Session> = {
    A: await Session.open('A', connectionString),
    B: await Session.open('B', connectionString),
  };
  const trace: string[] = [];
  const backlog: Record<SessionName, Step[]> = { A: [], B: [] };
  const fmt = (name: SessionName, e: Entry) =>
    `${name}:${e.label}→${e.state}${e.code ? `(${e.code})` : ''}`;

  async function decide(name: SessionName, entry: Entry, fn: Decide | undefined): Promise<void> {
    if (!fn) return;
    const decision = fn(entry.rows);
    if (decision !== 'ok') {
      sessions[name].outcome = decision;
      await sessions[name].client.query('ROLLBACK');
      trace.push(`${name}: service decision ${decision} → ROLLBACK`);
    }
  }

  async function execute(name: SessionName, step: Step): Promise<void> {
    const session = sessions[name];
    if (session.failed) {
      trace.push(`${name}:${step.label}→skipped(txn aborted ${session.failed})`);
      return;
    }
    if (session.outcome) {
      trace.push(`${name}:${step.label}→skipped(${session.outcome})`);
      return;
    }
    const entry = session.start(step.label, step.sql);
    const result = await settleOrBlock(inspector, session, entry);
    if (result === 'done') {
      trace.push(fmt(name, entry));
      if (entry.state === 'ok') await decide(name, entry, step.decide);
    } else {
      trace.push(`${name}:${step.label}→${result}`);
      if (step.decide) entry.decideWith = step.decide; // applied once it unblocks
    }
  }

  /** Reports steps that finished after being blocked, then runs backlogged steps. */
  async function pump(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const name of ['A', 'B'] as const) {
        const session = sessions[name];
        const last = session.log.at(-1);
        if (last && last.state !== 'running' && last.reported !== true && last.wasBlocked) {
          last.reported = true;
          trace.push(`${fmt(name, last)} (unblocked)`);
          if (last.state === 'ok') await decide(name, last, last.decideWith);
        }
        const next = backlog[name][0];
        if (!session.busy && next) {
          backlog[name].shift();
          await execute(name, next);
          progressed = true;
        }
      }
    }
  }

  try {
    for (const step of steps) {
      const session = sessions[step.s];
      const last = session.log.at(-1);
      if ((session.busy || backlog[step.s].length > 0) && last) {
        last.wasBlocked = true;
        backlog[step.s].push(step);
      } else {
        await execute(step.s, step);
      }
      // Give a just-released session a moment to finish, then run what it was waiting to do.
      for (const name of ['A', 'B'] as const) {
        const l = sessions[name].log.at(-1);
        if (l?.state === 'running') {
          l.wasBlocked = true;
          await settleOrBlock(inspector, sessions[name], l);
        }
      }
      await pump();
    }
    const drainStart = Date.now();
    while (
      (sessions.A.busy || sessions.B.busy || backlog.A.length > 0 || backlog.B.length > 0) &&
      Date.now() - drainStart < STEP_TIMEOUT_MS
    ) {
      await sleep(POLL_MS);
      await pump();
    }

    const outcome = (name: SessionName): Outcome => {
      const s = sessions[name];
      if (s.busy || backlog[name].length > 0) {
        trace.push(`${name}: TIMEOUT (still blocked)`);
        return 'timeout';
      }
      const committed = s.log.some((e) => e.label === 'COMMIT' && e.state === 'ok');
      return s.failed ?? s.outcome ?? (committed ? 'commit' : 'open');
    };
    const A = outcome('A');
    const B = outcome('B');
    const blockedSteps = trace
      .filter((t) => t.endsWith('→blocked'))
      .map((t) => t.replace('→blocked', ''));
    return { A, B, trace, blockedSteps };
  } finally {
    await sessions.A.close();
    await sessions.B.close();
  }
}
