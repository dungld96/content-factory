# Project Review — AI Content Factory

- Date: 2026-11-17
- Scope: whole repository at `d0e1b5f`: the M0 code (`apps/`, `packages/`, `infra/`, CI), the spec
  docs (`docs/*.md`), ADR-0001 to ADR-0011, and the M1 design review package (revision 4).
- Method: read all source, tests, config and ADRs, plus §0–§12 of
  `docs/design/M1-design-review-package.md`. Ran the local quality gates.
- Not done: integration tests (no Docker in the review environment), the M1 evidence scripts, and
  `pnpm audit`.

## 1. Summary

The project is in good shape for its stage. M0 is small, strict and well tested. The engineering
choices are deliberate and written down: strict TypeScript, Zod at every boundary, secret
redaction, SHA-pinned CI actions, loopback-only dev services and a sanitized error envelope.
The M1 design is unusually rigorous. It has evidence scripts, negative controls, and a
lock-ordering protocol that was checked with a deterministic harness.

The main risks are not in the M0 code:

1. **M1 is big.** It covers identity, sessions, CSRF, RBAC, eight trigger families with a global
   lock protocol, versioned assets, OpenAPI and a web login. That is one milestone carrying a lot
   of complexity before any content is produced (§4.1).
2. **A few design details should be fixed before M1 code starts**: the ETag source (§3.1), slug
   enumeration against the 404-for-non-members rule (§3.2), and M1 scope versus
   `IMPLEMENTATION_PLAN.md` (§3.3).
3. **The status docs disagree with each other** (§3.4).

One small M0 bug was found: `LocalTime` never actually shows local time (§2.1).

## 2. M0 code review

### Quality gates (run locally, Node 22.23.4)

| Gate                                          | Result                                            |
| --------------------------------------------- | ------------------------------------------------- |
| `pnpm format:check`                           | pass                                              |
| `pnpm lint` (`strictTypeChecked`, 0 warnings) | pass                                              |
| `pnpm typecheck`                              | pass                                              |
| `pnpm test` (unit + mocked HTTP e2e)          | pass: 7 files, 29 tests                           |
| `pnpm build`                                  | pass (API via `nest build`, web via `next build`) |
| `pnpm test:integration`                       | not run: needs PostgreSQL/Redis (CI runs it)      |

### Strengths

- **Config** (`packages/config`): fails fast, reports every issue, and never echoes values
  (tested). It avoids the `z.coerce.boolean()` trap where `"false"` parses as true. `redactUrl`
  also drops query strings.
- **Error envelope** (`apps/api/src/common/api-exception.filter.ts`): unknown errors become a
  generic 500, and stacks stay in server logs. 5xx messages are hidden except 503.
- **Correlation IDs**: caller-supplied values are validated against a safe pattern. They are held
  in a `WeakMap` rather than monkey-patched onto `req`.
- **Readiness**: probes are injectable, timeouts are bounded, and failure reasons are sanitized
  (`timeout`/`unreachable`). Liveness never touches dependencies. Both are tested.
- **No side effects in constructors**: Prisma and Redis connect lazily (CLAUDE.md §5).
- **Infra**: Redis uses `noeviction` and AOF, as BullMQ needs. Ports bind to loopback, and
  compose refuses to start without `POSTGRES_PASSWORD`.
- **CI**: SHA-pinned actions, `persist-credentials: false`, least-privilege `permissions`,
  a Node 22/24 matrix, real service containers, and a dependency audit.
- **Repository hygiene**: `.env`, `dist/`, `.next/`, `coverage/` and generated Prisma code are all
  ignored. `git ls-files` shows no build output or secrets.

### Findings

#### 2.1 `LocalTime` never renders the viewer's local time (bug, low) — **fixed**

`apps/web/src/components/local-time.tsx` picks its text with `typeof window` during render, and
relies on `suppressHydrationWarning`. React does **not** patch mismatched text when the warning is
suppressed. It keeps the server HTML, so users always see the raw UTC ISO string. This misses
CLAUDE.md §5 ("render user timezone in UI").

Fix: render the ISO string first, then format it after mount (`useEffect` + state, or
`useSyncExternalStore`). Add a component test with jsdom, or a Playwright check in M1.

#### 2.2 Prisma pool timeout is tied to the health-check timeout (medium; matters from M1)

`apps/api/src/infrastructure/prisma.service.ts` passes `HEALTH_CHECK_TIMEOUT_MS` (default 2 s) as
`connectionTimeoutMillis` for the **whole** pool. Once real queries exist, any request that waits
more than 2 s for a pooled connection fails. Approvals that serialize on locks (ADR-0010) make
that wait more likely. Add a separate `DATABASE_POOL_TIMEOUT_MS` and `DATABASE_POOL_MAX`, and let
the readiness probe keep its own timeout.

#### 2.3 The Redis client is not reusable for BullMQ as configured (low; note for M2/M5)

`RedisService` uses `maxRetriesPerRequest: 1`. BullMQ workers need `maxRetriesPerRequest: null`
and should have their own connections. The comment "later: BullMQ producers" suggests this client
will be reused. Plan for separate producer and worker connection factories instead.

#### 2.4 Unmapped 4xx statuses become `BAD_REQUEST` (low)

`STATUS_TO_CODE` has no entry for 402, 405, 406, 412, 413, 415 or 428. These fall back to
`BAD_REQUEST`. M1 plans to use `412 PRECONDITION_FAILED` and `428 PRECONDITION_REQUIRED`
(design §8.4), and M7 uses budget blocks. Add these mappings, or a generic code per status class,
before M1 depends on them.

#### 2.5 Minor

- `HealthService.liveness()` reads `npm_package_version`. It is only set when the API is started
  through pnpm/npm. `node dist/main.js` in a container always reports `0.0.0`. Inject the
  version at build time or read `package.json`.
- Request logging hooks only `finish`. Requests the client aborts (`close` without `finish`) are
  never logged. That matters later for long uploads and downloads.
- CORS is enabled on the API, but D3 says the browser only talks to the Next.js origin. Once the
  rewrite exists, disable CORS by default (empty allow-list) so the API cannot be called
  cross-origin by mistake.
- `API_HOST` defaults to `0.0.0.0`. That is fine in containers, but design §5.6 requires the API
  to be private. Consider `127.0.0.1` for local use and an explicit value in deployments.
- `prisma.config.ts` falls back to `''` for `DATABASE_URL`. A migrate command without the
  variable then fails with an unclear Prisma error rather than a clear message.

## 3. M1 design package (revision 4)

The package is thorough. Its strongest parts:

- Session revocation is shown to be safe with an UPDATE-only `set()`.
- The global lock order was tested against negative controls that reproduce earlier revisions'
  deadlocks.
- The DB roles are separated (`acf_migrator` / `acf_app`).
- Every SQLSTATE from a trigger is mapped to an API code.

The items below should be settled before or during approval.

### 3.1 ETag from `updatedAt` milliseconds is not a safe version token (medium)

§8.4 uses `ETag: W/"<updatedAt epoch-ms>"` and `UPDATE … WHERE updated_at = $2`. Prisma
`@updatedAt` is set by the **application clock**, at millisecond precision (`timestamptz(3)`).

- Two writes in the same millisecond produce the same ETag. A lost update is then possible.
- Clock skew between API instances, or an NTP step backwards, can repeat a value or move it
  backwards.
- Raw-SQL updates that forget `updated_at` leave the ETag unchanged.

**Recommendation**: add an integer `row_version` column. Increment it in the conditional UPDATE,
or with a trigger so raw SQL is covered too. Use it as the ETag, and keep `updatedAt` for display.
This is cheap now and expensive to change after clients depend on it.

### 3.2 Global project slugs leak existence to non-members (low/medium)

D7 returns 404 so non-members cannot tell a project exists. D12 makes slugs globally unique, so
`POST /projects` with a taken slug returns `409 SLUG_TAKEN` and reveals that a project with that
slug exists. Options:

- accept this and record it as known;
- scope slugs per creator or org;
- return a generic validation error.

Separately, `POST /members` returns `404 USER_NOT_FOUND`, which lets owners enumerate users. That
is acceptable for a CLI-provisioned MVP, but record it.

### 3.3 M1 scope differs from `IMPLEMENTATION_PLAN.md` (process)

The plan lists **job** entities in M1. The design package moves generation jobs to M2/M5 (§1).
The design also adds things the plan does not list: auth, sessions, CSRF, RBAC UI, OpenAPI and
triggers. Update `IMPLEMENTATION_PLAN.md` M1 deliverables and acceptance criteria in the same
change that approves the design (CLAUDE.md §10: milestone acceptance criteria changes need doc
updates).

### 3.4 Status documents disagree — **fixed**

| Document                         | Says                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `CLAUDE.md` §12                  | M1 rev. 4 awaits approval                                        |
| `README.md` "Implemented so far" | M1+ "Not started"                                                |
| `docs/adr/README.md`             | ADR-0010/0011 "Proposed (M1 package, rev. 3)"                    |
| ADR-0010/0011 headers            | Proposed, revision 4                                             |
| ADR-0009 header                  | "revision 3 of the M1 design review package is pending approval" |

Align them all on revision 4.

### 3.5 Design risks worth stating explicitly

- **Complexity budget.** Eight trigger families, a deferred constraint trigger, no-op
  "materializing" writes and a global lock order is a lot of machinery. It mostly protects
  against direct SQL in a single-tenant MVP. The evidence shows it works, but every future schema
  change to guarded tables has to keep it consistent (ADR-0011 notes this). Make sure the
  trigger-presence test, the drift test and the lock-matrix suite all run in CI from step 1 of
  §12, not later.
- **`40P01` handling.** §8.3 maps `40P01` to a retryable 409 "after one internal retry". ADR-0011
  says a `40P01` on a protocol-following path is a defect. Keep the retry, but make sure the
  first occurrence logs at error level and fails tests. A silent retry must not hide a lock-order
  regression.
- **Login throttling.** `@nestjs/throttler` with in-memory storage, keyed by IP behind a proxy,
  limits one IP only. Credential stuffing from many IPs against one account is not covered. Add
  a per-account limit (failed-attempt counter or backoff on the user row) to the M1 plan, or
  record it as a known gap.
- **Throttler key behind the Next.js hop.** Throttling uses `req.ip`, so it is only correct if
  `TRUST_PROXY` is right. Otherwise every request appears to come from the Next.js server and
  one user can lock everyone out. Add a test that the throttler keys on the forwarded client IP.
- **The session store is custom code.** It is well evidenced. Keep the R1–R8 and S1–S3 suites
  as permanent integration tests, as the design says, and treat any change to
  `PrismaSessionStore` as security-sensitive in review.
- **Evidence scripts in `docs/`** contain spike-only passwords (`acf_app_spike`) and target a
  container named `acf-postgres-1`. That is fine as reference material. Make sure none of it is
  copied into compose/CI as the real `acf_app` credential: generate it from `.env` the same way
  as `POSTGRES_PASSWORD`.

## 4. Process and roadmap

### 4.1 Consider splitting M1

M1 touches every layer and has the largest correctness surface of any milestone, yet produces no
user-visible content. Splitting it lowers review risk and keeps "each milestone runnable":

- **M1a — Identity and projects**: DB roles, sessions/auth/CSRF, RBAC, projects and members, web
  login and project list, permission-matrix test.
- **M1b — Brand assets**: channels, content items, characters/environments with versions and the
  approval protocol, asset metadata and lineage, triggers.

This is the owner's call. The design package's §12 steps 1–3 + 4 + 9 and 5–8 already map onto
this split.

### 4.2 Things to watch before M2

- Provider pricing and registry data need an effective date and a "reported vs estimated" flag
  (COST_STRATEGY, CLAUDE.md §2.13). Keep the M2 model registry's money type as integer micros
  from the start.
- The pnpm 10 → 11 upgrade is deferred (ADR-0007). Schedule it between milestones, not during
  one.
- The accessibility lint gap (ADR-0007, D10) means a11y is checked by review only. Adding
  Playwright + axe in M1's E2E would partly close it at no lint-dependency cost.

## 5. Recommended actions (by priority)

| #   | Action                                                               | Where              | When            |
| --- | -------------------------------------------------------------------- | ------------------ | --------------- |
| 1   | Replace the `updatedAt` ETag with an integer `row_version`           | M1 design §8.4     | before approval |
| 2   | Update `IMPLEMENTATION_PLAN.md` M1 scope; decide whether to split M1 | docs               | before approval |
| 3   | Align status in README, ADR index and ADR-0009 header to rev. 4      | docs               | **done**        |
| 4   | Decide on slug-enumeration and per-account login throttling          | M1 design §8, §11  | before approval |
| 5   | Fix `LocalTime` hydration                                            | `apps/web`         | **done**        |
| 6   | Separate the DB pool timeout from the health timeout                 | `apps/api`, config | M1 step 1       |
| 7   | Map 412/428/413/415/402 in the exception filter                      | `apps/api`         | M1 step 2       |
| 8   | Make `40P01` log at error level and fail tests, even with retry      | M1 step 2          | M1              |
| 9   | Disable CORS by default once the Next.js rewrite exists              | `apps/api`         | M1 step 9       |
| 10  | Separate BullMQ Redis connections                                    | M2/M5              | later           |
