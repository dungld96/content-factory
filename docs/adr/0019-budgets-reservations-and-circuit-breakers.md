# ADR-0019: Budgets with reservations, provider circuit breakers, resume and redaction

- Status: Accepted (M7 design package revision 1, approved 2026-11-20; implemented in M7a–M7d)
- Date: 2026-11-20
- Milestone: M7

## Context

Through M6 every paid stage showed an estimate, and clips had a per-request spend guard
(ADR-0017), but nothing stopped a project from spending without limit: concurrent requests, a
retried job or a lost video submission could each add cost nobody approved. Failed work could
only be redone stage by stage, a provider outage turned every queued job into a failure, and
credential redaction was applied in some places only. CLAUDE.md requires that unknown cost is
never zero, that budget blocks are never retried, and that keys never reach logs.

## Decision

1. **Budgets per project in PostgreSQL** (`project_budgets`): a monthly limit (UTC calendar month)
   and optional per-content-item and per-request limits, each `hard` (blocks: `402
BUDGET_EXCEEDED`) or `soft` (asks: `409 BUDGET_CONFIRMATION_REQUIRED`, accepted with
   `acceptOverBudget`, recorded as an override event). A hard breach always decides over a soft
   one. Defaults (10 hard / 3 soft / 2 hard USD) seed new projects; only owners change them, each
   change recorded in the append-only `budget_events`.
2. **Reservations, written with the jobs.** Every paid request reserves its estimate (text: the
   worst case of prompt allowance plus output ceiling, twice; unknown cost: USD 0.50 per call) in
   the transaction that queues its jobs, under a row lock on the budget, so concurrent requests
   can never together exceed it. Usage against a limit = ledger costs of calls no reservation
   covers + open and held reservations + charges owners confirmed.
3. **The worker re-checks before the paid call** and fails the job with `BUDGET_EXCEEDED` (no retry,
   reservation released) when the budget was lowered meanwhile. Jobs resolve their reservation as
   they end: settled (success), released, or **held** when the provider charge is unknown
   (`SUBMIT_OUTCOME_UNKNOWN`, a canceled submitted video). Held amounts keep counting until an
   owner records them as charged (kept as `settled_charge_usd`, because the ledger is immutable) or
   not charged.
4. **Circuit breaker per provider** (`provider_circuits`, shared by API and workers): five counted
   failures (timeouts, unavailable, network, provider errors) within ten minutes open it for five
   minutes; then exactly one trial job is admitted; a failed trial doubles the open time (max 30
   min). Jobs wait instead of failing: they are deferred without using an attempt, up to two hours.
   Operators open or close circuits with the registry CLI.
5. **Resume a run**: its failed or canceled stage is requested again for the same scope through the
   stage's normal endpoint (budgets, reuse) in one new run linked by `resumed_from_run_id`;
   possibly charged submissions are resumed only with explicit consent.
6. **Operations page and cost dashboard** read from PostgreSQL (queue depths from Redis when it
   answers), limited to the caller's projects; every figure keeps reported, estimated, unknown and
   held cost apart. Fixed log events (`budget_exceeded`, `budget_threshold`, `circuit_opened`,
   `circuit_closed`, `reservation_held`, `job_dead_lettered`, …) are the alerting interface.
7. **One redaction helper** (`@acf/config`) masks credentials in free text and secret-named fields,
   applied by both loggers, env validation, persisted job and provider error messages; tests send a
   fake key through every path.

## Consequences

- A request either fits the budget or is refused before anything is queued or called; the worst
  case of an unknown cost is visible and bounded, never $0.
- Reservations make estimates part of the books: a poor estimate blocks early (too high) or lets the
  ledger exceed it slightly (too low, bounded by the per-request limit).
- Held reservations need a human; the operations page lists them.
- One more lock per paid request (the project's budget row); requests of one project serialize
  briefly, which is acceptable for an editorial workload.
- An open circuit delays work by minutes instead of failing it; a permanently broken provider still
  fails jobs after two hours.

## Alternatives considered

- **Check budgets only in the API**: misses budgets lowered after queueing and concurrent workers.
- **Budgets in Redis counters**: fast, but not the source of truth (ADR-0002) and lost on restart.
- **Charge-after-the-fact only (no reservations)**: concurrent requests and long video jobs could
  overspend before any cost was recorded.
- **Rerouting to another provider when a circuit opens**: each task has one routed model today, and
  silent rerouting would change quality and price without approval.
