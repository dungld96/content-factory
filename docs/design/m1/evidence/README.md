# M1 design verification evidence (revision 4)

Scripts that validate the M1 design against the real stack **before** any M1 application code
is written. They are not part of the workspace build, and are excluded from lint and format. In
M1 they become Vitest integration tests.

Every suite builds a throwaway database (`acf_design_spike`) from the committed
[`../generated-tables.sql`](../generated-tables.sql) + [`../triggers.sql`](../triggers.sql). The
session spike is installed from its own pinned `package.json` + `pnpm-lock.yaml` into a temp
directory **outside** the workspace.

## Reproduce everything

Prerequisites: Node 22, pnpm 10, and `pnpm infra:up` (PostgreSQL 17.12 container
`acf-postgres-1`).

```bash
bash docs/design/m1/evidence/run-all.sh --negative-controls
```

Result on 2026-11-17 (revision 4):

```text
direct SQL suite (49 checks)                                PASS
concurrency: owners / links / master pointer (C1-C5)        PASS
concurrency C1-C5: no 40P01 (deadlock) in any session       PASS
concurrency: service last-owner algorithm RC/RR (C6, SQLSTATEs) PASS
archive vs approval, timed overlap (16, SQLSTATEs, U3 role) PASS
CRITICAL-1 SQL: set() UPDATE vs logout DELETE ordering      PASS
session spike build (pinned deps, prisma generate, tsc)     PASS
session suite: 49/49 passed                                 PASS
lock matrix: scenarios: 40, deadlocks (40P01): 0            PASS
Prisma drift with triggers applied is empty                 PASS
neg. control: approval w/o materializing write (RR)         PASS (control failed as expected)
neg. control: approval without asset check (direct SQL)     PASS (control failed as expected)
neg. control: rev-3 lock protocol deadlocks (deadlocks (40P01): 20) PASS (control failed as expected)
neg. control: rev-2 triggers break invariant (invariant violations: 14) PASS (control failed as expected)
neg. control: set() as upsert (session resurrection)        PASS (control failed as expected)
OVERALL: PASS
```

Per-scenario logs, including every statement's outcome and SQLSTATE, are written to
`$TMPDIR/acf-m1-evidence/logs/`. Set `TRACE=1` to print the lock-matrix traces.

The **negative controls** re-run the suites against the defective revision-2 designs. They must
fail, which shows the regression tests actually detect each defect.

## Files

| File | What it proves |
|---|---|
| `sql/test_direct_sql.sql` | 49 checks: every constraint and trigger rejects the forbidden operation **via direct SQL** with the expected SQLSTATE. Includes CRITICAL-2 cases (archived primary/linked asset → `AC010`; same-transaction approve-then-archive → `AC008`; U4 draft-only archive allowed) and environment-table coverage. |
| `sql/lock_matrix.mjs` | **Deterministic lock-boundary matrix** (revision 4). Sessions are sequenced by observed lock waits (`pg_blocking_pids`), not sleeps. 10 schedules × {primary, link} × {RC, RR} (owner schedules once per isolation) = 40 runs. Asserts both sessions' exact outcome/SQLSTATE, **fails on any `40P01`**, checks three invariants, and requires proof that the schedule actually blocked. Modes: `expect-pass`, `expect-deadlock` (rev-3 control), `expect-violation` (rev-2 control). |
| `sql/conc.sh` | C1–C5: owner demotion race, link insert vs in-flight approval, out-of-order approvals, double approval, REPEATABLE READ owner hazard. `run-all` fails if any session deadlocked. |
| `sql/conc2.sh` | C6: service last-owner algorithm (member → project → count) under RC and RR, asserting SQLSTATEs |
| `sql/conc_assets.sh` | **CRITICAL-2**, timed overlap: A1–A4 archive-vs-approval races (raw and service, both orders, primary and linked, RC and RR = 16 runs). **Asserts both sessions' psql exit codes and SQLSTATEs** (first commits; second `AC010`/`AC008`/409 decision at RC, `40001` at RR), **fails on `40P01`**, and checks the invariant. Runs as `acf_app` and checks that it cannot disable or drop triggers, truncate, or switch `session_replication_role` (U3). |
| `sql/conc_sessions.sh` | **CRITICAL-1, database level**: the store's UPDATE-only `set()` vs logout's DELETE, in all three orderings |
| `sql/errtest.ts` | How Prisma 7 + adapter-pg surfaces custom SQLSTATEs, unique/FK errors and deferred-trigger errors; `uuid(7)` |
| `session/src/prisma-session-store.ts` | **The actual Prisma 7 store** (single creation path, UPDATE-only `set`/`touch`) |
| `session/src/main.ts` | NestJS 12 app wiring express-session, csrf-csrf and the store; login uses `regenerate()` + `createForLogin()`. Includes spike-only test hooks. |
| `session/test.mjs` | 49 checks through the Next.js rewrite: the 25 baseline checks plus **R1–R8** (R1 = the reviewer's modify, pause, logout, complete scenario, proven via store events) |
| `session/run.sh` | Starts the API (as `acf_app`) and the Next.js proxy on a fresh DB, runs `test.mjs`, tears down |
| `session/web/next.config.mjs` | The same-origin rewrite, plus `agentRules: false` (verified: no `AGENTS.md` generated) |
| `run-all.sh` | Runs all of the above, plus the Prisma drift check and the negative controls |

## Baselines (defects reproduced before fixing)

- **Revision-3 deadlocks**: `lock_matrix.mjs` against `git show 372d976:docs/design/m1/triggers.sql`
  ends in `40P01` in 20/40 runs (D1, D6, D7, O1–O4). The cycles are documented in the package,
  §0.0. This is kept as negative control 5d.

- **CRITICAL 1**: with the revision-2 store (`INSERT … ON CONFLICT DO UPDATE` in `set`):
  - `logout: 204`, then the row is absent;
  - the slow modifying request completes and the row is **recreated**;
  - the old cookie gets **`/auth/me → 200`**.

  The same scenario is now R1 (passes), and the upsert variant is negative control 5c (fails).
- **CRITICAL 2**: with revision-2 triggers, a draft whose primary asset was archived could be
  approved through direct SQL, and the commit succeeded. Now `AC010`; the variant without the
  check is negative control 5b (fails).
