# M7 Design Review Package — Reliability and Cost Controls

- Status: **Revision 1, approved by the owner (2026-11-20)**: B1–B10 as proposed. Implemented in
  slices M7a–M7d (§14); deviations and clarifications in §15; ADR-0019. Awaiting review.
- Date: 2026-11-20
- Baseline: M6 approved (`1d3adbe`); ADR-0012 (ledger, money), ADR-0013 (jobs, retries, DLQ,
  reconciler), ADR-0017 (async provider jobs), ADR-0018 (rendering)
- Inputs: IMPLEMENTATION_PLAN §M7, COST_STRATEGY §4–§7, AI_PROVIDER_STRATEGY §4 (steps 5–6) and §7,
  API_SPEC §4 (`resume`), CLAUDE.md §2.13, §7, M5 package §9.2 (spend guard to be replaced),
  `docs/design/m5/benchmark-results.md`

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                                                                                                                | Section |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| B1  | **Budgets per project**: one monthly limit (UTC calendar month) plus optional per-content-item and per-request limits; each `hard` (blocks) or `soft` (asks for confirmation). Owners manage them; members see what is left                                                                                                           | §3      |
| B2  | **Defaults for new and existing projects**: monthly **USD 10 hard**, per content item **USD 3 soft**, per request **USD 2 hard** (configurable defaults; the owner changes them per project)                                                                                                                                          | §3.2    |
| B3  | **Reservations**: the estimated cost is reserved in the same transaction that records the job intent; released or replaced by the actual cost when the call ends. Spent = ledger costs + open reservations. An unknown estimate reserves a fixed **USD 0.50 per call** and still needs explicit acceptance                            | §4      |
| B4  | **Enforced twice**: by the API when work is requested (clear error, nothing queued) and by the worker right before each paid call (concurrent requests, changed budgets). A budget block is final: never retried                                                                                                                      | §5      |
| B5  | The M5 per-request video guard (`VIDEO_MAX_ESTIMATED_USD_PER_REQUEST`) becomes the **per-request budget** for every paid kind; the env value only seeds the default                                                                                                                                                                   | §3.2    |
| B6  | **Resume a production run**: one action re-queues only the run's failed or canceled work as a **new run**; succeeded results are reused through their execution keys. A video whose submission outcome is unknown is resumed only with explicit acceptance of a possible double charge                                                | §6      |
| B7  | **Circuit breaker per provider**, state in PostgreSQL (shared by API and workers): opens after **5 consecutive transient failures** (timeouts, 5xx, connection errors) within 10 min; open for **5 min**, then one trial call (half-open); success closes it. Routing skips open providers; work waits and retries instead of failing | §7      |
| B8  | **Operations page** (any signed-in user; project data limited to their memberships): queues, active and failed jobs, dead-letter entries, provider circuit states, spend per project this month; plus **log-based alerts** (fixed event names at `warn`/`error`), no new monitoring service                                           | §8      |
| B9  | **Cost dashboard per project** (COST_STRATEGY §6): this month vs budget; by content item, stage, provider/model; reported vs estimated vs unknown; retry cost; cost per approved video; monthly trend                                                                                                                                 | §9      |
| B10 | **Redaction proven by tests**: provider error bodies, headers, URLs and env dumps are scrubbed before logs and API errors; a test sweep sends a fake key through every error path                                                                                                                                                     | §10     |

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M7):** budget enforcement; retry/backoff and DLQ (exist since M3:
reviewed and extended to budget/circuit errors); job event history (exists: surfaced in the
operations page); monitoring and logs; provider circuit breaker. Plus what the acceptance needs:
reservations, run resume, cost dashboard, redaction tests.

**Out of scope:** multi-tenant billing and invoicing (CLAUDE.md §11); payment or credit purchase;
automatic fallback to _another provider_ when one is open (routing still uses the operator's route;
fallback models are a later routing feature); external monitoring stacks (Prometheus/Grafana,
paging); per-user quotas; currency other than USD.

**Acceptance (IMPLEMENTATION_PLAN §M7) and evidence:**

| Criterion                               | Evidence                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hard budget blocks expensive work       | API + worker integration tests: a request above the remaining monthly, item or request budget is refused (`402 BUDGET_EXCEEDED`), nothing queued, no provider call; two concurrent requests cannot together exceed the budget (reservation under a row lock); a worker re-check blocks a job whose budget was lowered after queueing |
| Failed jobs can resume                  | Integration + E2E: a run with failed scenes resumes as a new run that re-queues only those scenes; succeeded scenes are not called again (mock provider call counts)                                                                                                                                                                 |
| Logs redact credentials                 | Redaction sweep test across provider errors, HTTP errors and start-up config; no key, `Authorization` value or signed URL appears in captured logs or API responses                                                                                                                                                                  |
| Costs distinguish reported vs estimated | Cost dashboard and reports keep reported, estimated and unknown apart (never summed into one figure; unknown never shown as 0), tested on fixtures with all three                                                                                                                                                                    |

## 2. What exists and what changes

| Area            | Today                                                                               | M7                                                                                          |
| --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Retries         | Bounded exponential backoff with jitter, `Retry-After`, non-retryable classes (M3)  | + `BUDGET_EXCEEDED` (final), `PROVIDER_CIRCUIT_OPEN` (wait for the circuit, not an attempt) |
| DLQ             | Finally failed jobs copied to `generation-dlq` (M3)                                 | Listed on the operations page with the job and error                                        |
| Job events      | Every transition recorded (M3–M6)                                                   | Shown per job on the operations page                                                        |
| Cost            | Ledger: reported / estimated / unknown (M2); per-job and per-render reports (M3–M6) | Budgets, reservations, dashboard                                                            |
| Spend guard     | Video only, per request (M5)                                                        | Per-request budget for every paid kind (B5)                                                 |
| Provider health | None (a failing provider is retried per job)                                        | Circuit breaker (B7)                                                                        |

## 3. Budgets (B1, B2, B5)

### 3.1 Model

`project_budgets` (one row per project): `monthly_limit_usd`, `monthly_mode`,
`item_limit_usd` (nullable), `item_mode`, `request_limit_usd` (nullable), `request_mode`,
`updated_by_id`, timestamps. Amounts are exact decimals (ADR-0012); a limit of `0` blocks all paid
work. Every change is recorded in `budget_events` (append-only: who, old → new).

### 3.2 Defaults

Migration and project creation create the row with the defaults of B2 (env
`DEFAULT_MONTHLY_BUDGET_USD=10`, `DEFAULT_ITEM_BUDGET_USD=3`, `DEFAULT_REQUEST_BUDGET_USD` seeded
from today's `VIDEO_MAX_ESTIMATED_USD_PER_REQUEST`, default 2). The pilot envelope of
COST_STRATEGY §7 (USD 50–100) is set by the owner, not assumed.

### 3.3 What counts

`spent(scope, period)` = Σ ledger cost of `ai_invocations` in scope and period (reported if present,
else estimated) + Σ open reservations + Σ reservations held by `outcome_unknown` invocations (an
unknown outcome is not free, CLAUDE.md §2.13). Period: the UTC calendar month of the invocation's
start (shown in the user's timezone). Rendering (local FFmpeg) costs nothing and is not limited.

### 3.4 Modes

- `hard`: a request whose reservation would exceed the remaining amount → `402 BUDGET_EXCEEDED`
  with `{ scope, limitUsd, spentUsd, reservedUsd, requestedUsd }`.
- `soft`: the same check returns `409 BUDGET_CONFIRMATION_REQUIRED`; resending with
  `acceptOverBudget: true` proceeds and records the override in `budget_events`.
- 80 % of the monthly budget raises a warning in the UI and a `budget_threshold` log event.

## 4. Reservations (B3)

`budget_reservations`: `job_id`, `project_id`, `content_item_id`, `amount_usd`, `kind`
(`estimate` | `unknown_placeholder`), `status` (`open` | `settled` | `released` | `held`),
timestamps. Lifecycle:

| Event                                                                    | Reservation                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Job intent created (API, same transaction, budget row `FOR UPDATE`)      | `open`, amount = estimate × 1 (video: billed seconds incl. model minimum, M5 fix) or USD 0.50 per call if unknown |
| Call succeeded, cost reported or estimated in the ledger                 | `settled` (the ledger amount counts; the reservation no longer does)                                              |
| Call failed and the provider reports no cost / refused before acceptance | `released`                                                                                                        |
| Outcome unknown (`SUBMIT_OUTCOME_UNKNOWN`, abandoned)                    | `held`: keeps counting until an operator settles or releases it (operations page)                                 |
| Job canceled before any call                                             | `released`                                                                                                        |

Text jobs with a repair call reserve two calls (M3 Q5). Image jobs reserve all their calls.

## 5. Enforcement points (B4)

1. **API**, when work is requested (scripts, storyboards, images, clips, voice-overs, resume):
   checks per-request, per-item and monthly limits against the request's estimate; creates the
   reservations with the jobs. Estimates already exist for every paid kind (M3–M5).
2. **Worker**, right before each paid provider call (in `LlmService`/`ImageService`/`VideoService`/
   `TtsService` via a `BudgetGuard` dependency): re-reads the budget under the same lock; if the
   job's own reservation no longer fits (budget lowered meanwhile), the job fails with
   `BUDGET_EXCEEDED` (no retry, DLQ copy, reservation released).
3. Polls and downloads of an already submitted video are never blocked (the cost is incurred).

## 6. Resume (B6)

`POST /production-runs/:runId/resume` (editor): for each failed or canceled job of the run, the
same stage is requested again for the same scope (text job → same kind for the item; scene job →
that scene; render → same options) in **one new run**, through the same planning code as a normal
request (budget checks, reuse of succeeded results). Response: the new run and what was skipped and
why. Jobs ended with `SUBMIT_OUTCOME_UNKNOWN` are listed but resumed only with
`acceptPossibleDoubleCharge: true` (ADR-0017). The UI offers **Resume** on a run with failures and
**Retry scene** per failed scene (existing regenerate actions).

## 7. Circuit breaker (B7)

`provider_circuits` (one row per provider key): `state` (`closed` | `open` | `half_open`),
`consecutive_failures`, `opened_at`, `retry_at`, `last_error_code`, `updated_at`; transitions in
`provider_circuit_events`. Counted: `TIMEOUT`, `PROVIDER_UNAVAILABLE`, network errors, HTTP 5xx.
Not counted: invalid request, content policy, auth, credits, rate limits with `Retry-After`
(handled by backoff), budget. Rules:

- closed → open after 5 consecutive counted failures within 10 min (`log: circuit_opened`).
- open: routing (step 6 of AI_PROVIDER_STRATEGY §4) skips the provider; a job that needs it is
  rescheduled for `retry_at` with `PROVIDER_CIRCUIT_OPEN` (does not use an attempt; capped at 2 h,
  then fails `PROVIDER_UNAVAILABLE`).
- after 5 min: half-open; exactly one call is let through (row lock); success → closed, failure →
  open again (`retry_at` doubles, max 30 min).
- Operators can close or open a circuit manually (operations page / CLI), recorded as an event.

## 8. Operations page and alerts (B8)

`GET /ops/summary`: queue depths (waiting, active, delayed, failed) per queue; jobs by status and
kind over 24 h; DLQ entries (newest 50: job, kind, error, project — only projects the caller is a
member of); provider circuits; spend this month vs budget for the caller's projects;
held reservations. Web: an **Operations** page in the sidebar; failed jobs link to their content and
run (Resume).

Alerts are structured log events with fixed names, so any log shipper can alert on them:
`budget_exceeded`, `budget_threshold`, `circuit_opened`, `circuit_closed`, `job_dead_lettered`,
`reservation_held`, `reconciler_requeued`. Documented in DEPLOYMENT.md with example filters.

## 9. Cost dashboard (B9)

`GET /projects/:projectId/costs?month=YYYY-MM`: month total vs budget; by content item; by stage
(job kind); by provider/model; **retry cost** (attempts that failed but were charged);
**cost per approved video** (approved renders' content items); last 6 months trend. Every figure
keeps `reportedUsd`, `estimatedUsd`, `unknownCalls` and `heldUsd` apart. Web: a **Costs** tab on
the project page; the budget editor (owners) next to it.

## 10. Redaction (B10)

Existing `redact` helpers (config, provider errors) are applied at three boundaries: the logger
(every field), provider error construction (messages and bodies), and the API error filter. A test
sweep injects a recognisable fake key and `Authorization` header through: provider 4xx/5xx bodies
that echo the request, fetch errors with URLs, start-up env validation errors, Prisma errors, and
the DLQ payload; it asserts the key never appears in captured logs, API responses or job rows.

## 11. API (base `/api/v1`)

| Endpoint                                        | Viewer | Editor | Owner | Notes                                                                  |
| ----------------------------------------------- | :----: | :----: | :---: | ---------------------------------------------------------------------- |
| `GET /projects/:projectId/budget`               |   ✓    |   ✓    |   ✓   | Limits, modes, spent/reserved/held this month                          |
| `PUT /projects/:projectId/budget`               |  403   |  403   |   ✓   | Limits and modes; recorded in `budget_events`                          |
| `GET /projects/:projectId/costs`                |   ✓    |   ✓    |   ✓   | Dashboard (§9)                                                         |
| `POST /production-runs/:runId/resume`           |  403   |  202   |  202  | §6                                                                     |
| `GET /ops/summary`                              |   ✓    |   ✓    |   ✓   | §8 (project data limited to memberships)                               |
| `POST /ops/reservations/:id/settle`, `/release` |  403   |  403   |   ✓   | Held reservations of the owner's projects                              |
| `POST /ops/circuits/:providerKey/reset`         |   —    |   —    |   —   | Operator CLI only (`pnpm ai:registry circuit …`): providers are global |

Existing generate endpoints accept `acceptOverBudget` and may answer `402 BUDGET_EXCEEDED` or
`409 BUDGET_CONFIRMATION_REQUIRED`. New error codes: `BUDGET_EXCEEDED`,
`BUDGET_CONFIRMATION_REQUIRED`, `PROVIDER_CIRCUIT_OPEN`, `NOTHING_TO_RESUME`.

## 12. Risks

| ID  | Risk                                                       | Mitigation                                                                                                          |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R1  | Estimates below actual billing (seen in M5: Kling minimum) | Reservations settle to the ledger amount; dashboard shows estimate vs actual per model; per-model minimums (M5 fix) |
| R2  | Lock contention on the budget row                          | One short `FOR UPDATE` per request/call; requests are human-paced                                                   |
| R3  | Unknown-cost calls under-reserved                          | Fixed placeholder (B3) + explicit acceptance; held reservations visible until settled                               |
| R4  | Circuit opens on a transient blip and stalls work          | 5 consecutive failures, 5 min, half-open trial; manual reset; work waits instead of failing                         |
| R5  | Budget changes mid-run surprise users                      | Worker re-check fails clearly (`BUDGET_EXCEEDED`), resume after raising the budget                                  |
| R6  | Month boundary in UTC differs from the user's month        | Documented; UI shows the UTC period in local time                                                                   |

## 13. Testing

| Layer              | What                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit               | Budget arithmetic (exact decimals, modes, scopes, month boundaries); reservation lifecycle; circuit state machine; resume planning; redaction helpers                         |
| DB integration     | Migration, append-only events, reservation CHECKs, one budget row per project                                                                                                 |
| API integration    | Hard/soft blocks per scope; concurrency (two requests racing for the last dollars); resume; dashboard figures on mixed reported/estimated/unknown fixtures; permission matrix |
| Worker integration | Re-check blocks a job after the budget was lowered; reservations settle/release/hold per outcome; circuit opens after failures and work waits; half-open trial                |
| Redaction sweep    | §10                                                                                                                                                                           |
| E2E (Playwright)   | Owner sets a tiny budget → generation blocked with a clear message → raises it → resumes the run; operations and costs pages render real data                                 |

No paid calls: mock providers simulate failures, costs and outages.

## 14. Implementation plan (each slice tested before the next)

| Slice | Scope                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7a   | Migration (budgets, events, reservations); budget domain; API enforcement and reservations on every paid request; spend guard replaced; budget API |
| M7b   | Worker re-check and reservation settlement; circuit breaker (state, routing filter, waits, CLI); redaction sweep                                   |
| M7c   | Resume; operations summary; cost dashboard API                                                                                                     |
| M7d   | Web: budget editor and warnings, Costs tab, Operations page, Resume; E2E; docs (COST_STRATEGY, API_SPEC, DATABASE, DEPLOYMENT alerts); ADR-0019    |

## 15. Deviations and clarifications found during implementation

| Slice | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7a   | **Hard beats soft.** Limits are checked request → item → month, but a hard breach anywhere decides the request, so accepting a soft breach (`acceptOverBudget`) can never override a hard limit (e.g. item soft and month hard both exceeded → `402`, scope `month`).                                                                                                                                                                                                                                         |
| M7a   | **Text reservations.** A script or storyboard job reserves its worst case: prompt allowance (6 000 / 12 000 tokens) plus the output ceiling, priced with the model's active prices, times two (one repair call). An unpriced model reserves USD 0.50 per call (USD 1.00 per job).                                                                                                                                                                                                                             |
| M7a   | **Images** reserve per scene job; an unknown image estimate reserves USD 0.50 per image requested (`count`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| M7a   | **Budget rows are created lazily** with the `DEFAULT_*_BUDGET_USD` values on first read or reservation; the migration backfills existing projects. `GET` creates the row too (its defaults are then visible and editable).                                                                                                                                                                                                                                                                                    |
| M7a   | The video estimate's `spendGuardUsd` is replaced by `requestBudgetUsd` (`null` when the project has no per-request limit); `422 SPEND_GUARD` and `VIDEO_MAX_ESTIMATED_USD_PER_REQUEST` are removed. The clips panel blocks a request above the per-request budget; the full soft-limit confirmation arrives in M7d.                                                                                                                                                                                           |
| M7b   | **Where the worker re-checks.** The budget re-check runs once per attempt in the processor, after the attempt starts and before any provider call, instead of inside each AI service: one place covers every paid kind. Polls and a resumed (already submitted) video are never re-checked.                                                                                                                                                                                                                   |
| M7b   | **Settlement.** Success → `settled`; `SUBMIT_OUTCOME_UNKNOWN` → `held`; any other final failure → `released`; cancel → `held` for a video already submitted, else `released`. A released or settled reservation stops counting and the job's ledger rows count instead, so a call that finishes after a cancel is still counted.                                                                                                                                                                              |
| M7b   | **Circuits make jobs wait, not reroute.** Each task has one routed model, so an open circuit defers the job (BullMQ `moveToDelayed`: neither a PostgreSQL nor a BullMQ attempt is used). The 2 h cap is measured from the job's `queued_at`. Counted failures: `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `NETWORK`, `PROVIDER_ERROR`; any other provider answer counts as the provider being reachable (it resets the count and closes a half-open trial). A trial that never reports back is replaced after 10 min. |
| M7b   | **Circuit CLI**: `pnpm ai:registry circuit list`, `circuit open                                                                                                                                                                                                                                                                                                                                                                                                                                               | close <providerKey>` (manual events; the operations page follows in M7c/M7d). |
| M7b   | **Redaction** is one helper set in `@acf/config` (`redactSecrets`, `redactValue`): bearer/basic credentials, `sk-` keys, credentials in URLs, signed-URL and token query parameters, `key=value` secrets, and secret-named fields. Applied by the worker logger, a redacting Nest console logger, env validation messages, persisted job error messages and `sanitizeProviderMessage` (so the ledger too); `@acf/ai-core` now depends on `@acf/config` for it.                                                |
| M7c   | **Resume uses the stage's own endpoint.** A run only ever holds jobs of one stage, so a resume is one request of that stage for the failed scope (current routing; original count, resolution, seed and audio options; render captions and music). The new run is linked by `production_runs.resumed_from_run_id` (new column, set once). Clips still need `confirmedEstimateUsd` (the estimate guard of M5 applies to resumed clips too).                                                                    |
| M7c   | **Settling a held reservation** keeps its amount as `settled_charge_usd`, counted as spent (budget usage, and as estimated cost on the dashboard): the ledger is immutable once a call has an outcome, so the charge cannot be written there. A held reservation replaces its ledger rows on the dashboard, as in budget usage.                                                                                                                                                                               |
| M7c   | **Ops summary failures** come from PostgreSQL (finally failed jobs, each of which has a dead-letter copy), so they can be limited to the caller's projects; the DLQ depth is shown with the queues. Queues and circuits are visible to every signed-in user (counts and provider names only).                                                                                                                                                                                                                 |
| M7d   | **Soft-limit confirmation is one browser dialog in the shared request helper**: any request answered `409 BUDGET_CONFIRMATION_REQUIRED` shows the API's message and, if confirmed, is sent once more with `acceptOverBudget: true`, so every generate button (and Resume) gets it without its own code. Hard limits are never retried.                                                                                                                                                                        |
| M7d   | **Where things live**: the **Costs** page is a separate page of the project (link in the project header; budget warning banner on the project page at 80 %); **Operations** is a sidebar entry; **Resume** appears on a failed or canceled job line of the content workspace and on each failed job of the Operations page; held reservations are resolved there as **Charged** / **Not charged**.                                                                                                            |
| M7d   | Alert log names as designed: `job_dead_lettered` is new (alongside `job_failed`), and the reconciler's summary event is renamed `reconciler_requeued` (was `reconciled`). Free-tier vs paid usage (COST_STRATEGY §6) is not shown: no provider in use has a free tier we rely on.                                                                                                                                                                                                                             |
