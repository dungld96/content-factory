# M1 Review — Domain, Persistence, Identity & Access

- Scope: M1a–M1e on branch `claude/gracious-planck-kuf4pq` (`f4ec2aa` … `9b298ed`), against
  `docs/design/M1-design-review-package.md` revision 4 and ADR-0009 to ADR-0011.
- Date: 2026-11-17. Reviewer: Claude (the same agent that implemented M1). Treat this as a
  self-review: the findings were looked for adversarially and each one marked **Confirmed** was
  reproduced, but an independent human review is still recommended before M2.
- Size: 138 files, about 12.9k added lines (code, tests, docs).

## 1. Verdict

**M1 meets its acceptance criteria and the approved design, with one defect to fix before M2
(finding 1) and four low-severity issues worth fixing soon (findings 2–5).** No finding can
produce invalid committed data: every invariant is enforced by the database itself, and the
concurrency tests check the invariants after each race.

| Acceptance criterion (IMPLEMENTATION_PLAN M1) | Evidence                                                                                                                              | Met |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Migrations work on an empty database          | Every test database (`acf_test`, `acf_test_api`, `acf_test_e2e`) is built from empty by `prisma migrate deploy`; drift check is empty | Yes |
| Integration tests cover core CRUD             | Every M1 resource has create/read/update/archive tests against PostgreSQL                                                             | Yes |
| Authorization boundaries are defined          | Table-driven matrix: 48 routes × 5 callers, plus a test that fails if a route is missing from the table                               | Yes |

## 2. Findings

Severity: **Medium** = a design guarantee is violated in a reachable path; **Low** = correct
outcome but a real usability, robustness or hardening gap; **Info** = note only.

### 1. Medium — Concurrent `PUT …/versions/:id/assets` deadlocks (Confirmed)

- **Where**: `apps/api/src/brand/versioned-entity.service.ts`, `replaceAssets`.
- **What**: the transaction deletes the draft's links, inserts the new ones, then updates the
  version row (to change its ETag). Each link insert fires the link trigger, which reads the
  version `FOR SHARE`. When the draft has **no existing links**, the DELETE locks nothing, so two
  concurrent PUTs both acquire `FOR SHARE` on the version and then both try to upgrade to the
  row lock for the UPDATE: a lock-upgrade deadlock.
- **Evidence**: two concurrent PUTs (different assets) on a fresh draft, 10 races: **8 ended in
  `40P01`** in the PostgreSQL log (both sessions blocked on the version `UPDATE`).
- **Impact**: clients did not see it. `TransactionRunner` retried once and both requests
  returned 200, the last writer winning, which is the expected outcome without `If-Match`. But
  ADR-0011 §6 states that a `40P01` on a protocol-following path is a defect. Each occurrence
  costs the deadlock timeout (1 s), an error-level log line, and if the retry also deadlocks, a
  `409 CONCURRENT_MODIFICATION`.
- **Why the tests missed it**: the deterministic lock matrix covers raw single-statement link
  edits, not the multi-statement service PUT, and no API-level race test targets PUT.
- **Fix**: take the version row lock before touching links:
  `SELECT … FROM versions WHERE id = $1 AND status = 'draft' FOR NO KEY UPDATE`, then delete,
  insert and update. This serializes PUTs on the version. It inverts the documented
  "link row → version" order for this one service path. The only remaining cycle would be with a
  raw multi-row link edit running concurrently, which ADR-0011 §6 already accepts as "raw SQL
  outside the protocol". Record the exception in ADR-0011. Add an API race test (two PUTs, with
  and without existing links) that fails on any `40P01` in the server log or a retry warning.

### 2. Low — Version lists can be out of version order under concurrent creation (Confirmed by code)

- **Where**: `VersionedEntityService.createVersion` and `listVersions`.
- **What**: version numbers are assigned in parent-lock order. `created_at` comes from the
  column default `CURRENT_TIMESTAMP`, which is the transaction **start** time. A transaction
  that started first but got the lock second receives the higher version number with the earlier
  `created_at`. `listVersions` orders and paginates by `(created_at, id)`, so "newest first"
  can show v3 after v4. The code comment claiming creation order equals version order is wrong.
- **Fix**: order versions by `version DESC` and use a version-number cursor (unique per parent).

### 3. Low — Fetching a CSRF token in one tab breaks the other tabs (Confirmed)

- **Where**: `apps/api/src/auth/csrf.service.ts` (`generateCsrfToken(..., { overwrite: true })`).
- **Evidence**: tab A holds a token from login. Tab B (same cookies) calls `GET /auth/csrf`.
  Tab A's next state-changing request gets `403 CSRF_INVALID`; tab B's succeeds.
- **Impact**: today only sign-out uses CSRF in the UI, so the effect is small. M3's editing UI
  will hit random 403s for users with several tabs open.
- **Fix**: use `overwrite: false` for `GET /auth/csrf` (reuse the existing valid cookie). Keep
  overwriting at login, where the session ID changes anyway. Add a multi-tab test.

### 4. Low — Login throttling is per IP only and in memory (Design gap)

- **Where**: `AuthModule` / `@nestjs/throttler` on `POST /auth/login`.
- **What**: the limit is keyed on `req.ip`, which is only correct if `TRUST_PROXY` names every
  proxy hop. With a wrong value, either all users share one IP (anyone can lock everyone out of
  login for a minute), or a client-supplied `X-Forwarded-For` decides the key (bypass). There is
  no per-account limit, so distributed credential stuffing against one account is unthrottled.
  Storage is per process (already listed as accepted in design §11 for the single-instance
  pilot).
- **Fix (before any public deployment)**: add a second throttle keyed on the normalized email,
  move throttler storage to Redis, and add a deployment check that `req.ip` is a client address
  behind the real proxy chain.

### 5. Low — Sign-out failures are silent in the web app

- **Where**: `apps/web/src/app/projects/logout-button.tsx`.
- **What**: the button navigates to `/login` in `finally`, whatever `POST /auth/logout`
  returned. If logout fails (for example `403` from finding 3, or the API being down), the
  session stays valid. `/login` then sees a valid session and redirects back to `/projects`
  with no message. Nothing is exposed, but on a shared computer the user believes they signed
  out when they did not.
- **Fix**: navigate only on `204` (or `401`); otherwise show an error and keep the button.

### 6. Low — Long lock waits surface as 500

- **Where**: `TransactionRunner` uses Prisma's interactive-transaction defaults (`maxWait`
  2 s to get a connection, `timeout` 5 s for the whole transaction).
- **What**: approvals of one character and owner changes of one project are serialized by
  design. Under a burst, or a stuck transaction holding a row lock, Prisma aborts with `P2028`,
  which the error mapper does not recognise, so the client gets `500 INTERNAL_ERROR` instead of a
  retryable response.
- **Fix**: map `P2028` (and pool-acquisition timeouts) to `503 SERVICE_UNAVAILABLE` with
  `retryable: true`, and set explicit `maxWait`/`timeout` values per operation.

### 7. Info — Owners can test whether an email has an account

`POST /projects/:id/members` returns `404 USER_NOT_FOUND` for unknown emails. Only project
owners can call it and accounts are CLI-provisioned (D6), so this is acceptable for the pilot.
Revisit if sign-up or invitations are added.

### 8. Info — Smaller deviations and notes

- Design §8.3 lists `CROSS_PROJECT_REFERENCE` or `REFERENCE_NOT_FOUND` for foreign-key errors;
  the mapper always returns `422 REFERENCE_NOT_FOUND`. The services pre-check same-project
  references, so the user-facing codes are right; only the database backstop is less specific.
- `listVersions` loads links with one query per version (N+1, at most 100). Fine at MVP volume.
- `apps/web/src/proxy.ts` reads `API_INTERNAL_URL` directly; the rest of the web app reads it
  through the validated `serverEnv()`. A malformed value fails at request time, not at startup.
- The "bytes" limits on `metadata` and `rules` count JSON characters, not bytes.
- Documented deviation (ADR-0009 note): the same-origin proxy is a Next.js 16 runtime rewrite
  (`src/proxy.ts`), not `next.config.ts` rewrites, so `API_INTERNAL_URL` is a runtime setting.
  It also sets `X-Forwarded-Proto: http` when the client sends none, unlike what the design spike
  recorded for config rewrites. This is safe: the TLS proxy must overwrite the header, and
  secure-mode login fails closed otherwise.

## 3. Design conformance

| Area                                    | Design                     | Implementation                                                                                                                               | Status                              |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Schema, composite FKs, CHECKs, triggers | §2–§6, ADR-0011            | `init_m1` = reviewed DDL (byte-identical) + rev-4 `triggers.sql`                                                                             | Conforms                            |
| Roles (U3)                              | `acf_migrator` / `acf_app` | `pnpm db:setup`; `acf_app` verified unable to disable/drop triggers, truncate, set `session_replication_role`, or touch `_prisma_migrations` | Conforms                            |
| Lock protocol, no `40P01`               | ADR-0011 §5–6              | Approve, archive, owner changes, version creation conform and are race-tested; **link replacement does not (finding 1)**                     | Partly                              |
| Approval + master pointer               | ADR-0010, §7               | Exact algorithm; `ALREADY_APPROVED` (with current state), `STALE_DRAFT`, `ASSET_ARCHIVED`, `If-Match`                                        | Conforms                            |
| Sessions (D2, D5)                       | ADR-0009, §5               | Evidenced store ported; single INSERT path; UPDATE-only set/touch; R1–R8 pass; upsert negative control fails R1–R5                           | Conforms                            |
| Cookies, Origin, CSRF                   | §5.4, §5.7                 | `__Host-` in secure mode, fail-closed login, Origin → session → CSRF order                                                                   | Conforms (finding 3)                |
| RBAC, 404 for non-members (D7)          | §8.1–8.2                   | `ProjectAccess` in services; matrix over every route                                                                                         | Conforms                            |
| Optimistic concurrency (D9)             | §8.4                       | Weak ETags, conditional updates, `REQUIRE_IF_MATCH` → 428                                                                                    | Conforms                            |
| Pagination, OpenAPI, validation         | §8.5                       | Opaque cursors, OpenAPI 3.1 from the same Zod schemas, route-coverage test, strict objects                                                   | Conforms (finding 2)                |
| Web (D3, D4)                            | §9                         | Login, projects, logout through the same-origin proxy; Playwright E2E                                                                        | Conforms (runtime proxy; finding 5) |
| Owner decisions at the M1b–M1d review   | design §12 note            | One `rules` field; `generated` refused until M4; new archived references refused; demo seed                                                  | Conforms                            |

## 4. Test evidence

All run locally on 2026-11-17 (PostgreSQL 16.15 locally; CI uses 17.12, which has not run on
these commits yet):

| Suite                                                                           | Result                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm test` (unit, packages + API HTTP with mocks)                              | 140 passed                                                                                              |
| `pnpm test:integration` (`integration:database` + `integration:api`)            | 464 passed                                                                                              |
| `pnpm test:e2e` (Playwright, Chromium)                                          | 5 passed                                                                                                |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`                | Clean                                                                                                   |
| `pnpm audit --audit-level=moderate`                                             | No known vulnerabilities                                                                                |
| Negative controls run once during implementation (not in CI, by owner decision) | Rev-3 triggers: matrix fails on the 7 documented deadlock scenarios; upsert session `set()`: R1–R5 fail |
| Repeated race runs                                                              | Owner demotions 15/15; approval vs approval and approval vs archive 20/20 runs (100 races each)         |

Strengths worth keeping: the database enforces every invariant independently of the API; the
lock-boundary harness is deterministic (no sleeps); the session suite uses gates inside handlers
instead of timing; every race test checks invariants, not just status codes; and the
permission matrix fails when a new route is added without a row.

Gaps: no API-level race test for link replacement (finding 1); no multi-tab CSRF test
(finding 3); no test for the session-store-failure `503` path; E2E covers Chromium only; CI has
not yet run the M1 commits on PostgreSQL 17.12.

## 5. Recommended actions

Before starting M2:

1. Fix finding 1 and add the API race test; record the lock-order exception in ADR-0011.
2. Push and confirm CI is green on PostgreSQL 17.12 (it has not run on the M1 commits yet).

Soon (can be one small follow-up PR):

3. Findings 2, 3, 5 and 6: small, local fixes, each with a test.

Before any public deployment:

4. Finding 4: per-account login throttling, Redis-backed throttler storage, and a
   proxy-chain check.
