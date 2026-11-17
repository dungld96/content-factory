# Project Review — M1 (Domain, Persistence, Identity & Access)

- **Scope**: M1a–M1e plus the finding-1 fix, on branch `claude/gracious-planck-kuf4pq`
  (`f4ec2aa` … `6afd28e`: 158 files, about 13.7k added lines). Checked against
  `docs/design/M1-design-review-package.md` revision 4 and ADR-0009 to ADR-0011.
- **Date**: 2026-11-17.
- **Reviewer**: Claude, the same agent that implemented M1. This is a self-review. A human
  review is still needed before M2 (CLAUDE.md §12: M1e is awaiting review).
- **Relation to the earlier review**: an earlier `REVIEW.md` (`7680ffb`, removed in `ce4493f`)
  reported findings 1–8. Finding 1 is fixed in `79360a3`. Findings 2–8 are still open and are
  listed again in §3 so this file stands on its own. §2 lists new findings.

## 1. Verdict

**M1 meets its acceptance criteria. All checks pass. I found no defect that can commit invalid
data**, because the database enforces every invariant itself.

Two things should be done before M2:

- Fix new finding N1. Web navigation never renews the session cookie, so the 24-hour idle
  timeout acts as a fixed 24-hour limit from login.
- Run CI once on these commits (N5). The branch has no PR, so CI has never run on M1, and so
  never on PostgreSQL 17.12 or Node 24.

The other findings are low severity or notes.

| Acceptance criterion (IMPLEMENTATION_PLAN M1) | Evidence                                                                           | Met |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | --- |
| Migrations work on an empty database          | Every test database is built from empty by `prisma migrate deploy`                 | Yes |
| Integration tests cover core CRUD             | Create/read/update/archive tests against PostgreSQL for every M1 resource          | Yes |
| Authorization boundaries are defined          | Permission matrix covers every route × 5 caller types and fails on unlisted routes | Yes |

## 2. New findings

Severity scale (same as the earlier review):

- **Medium**: a design guarantee is broken in a path users can reach.
- **Low**: the outcome is correct, but there is a real gap in usability, robustness or hardening.
- **Info**: a note only.

### N1. Medium — The web app never renews the rolling session cookie (confirmed by reading the code)

- **Where**:
  - `apps/web/src/lib/api-server.ts` (`apiGet`)
  - `apps/api/src/auth/session/session.middleware.ts` (`rolling: true`, `maxAge = SESSION_IDLE_TTL_MS`)
- **What**:
  - The cookie's `Max-Age` (24 h) is meant to be renewed on every response. That gives D5's
    "24 h idle, 7 days absolute" policy.
  - The web pages read data through server-side `apiGet`. That function forwards the browser's
    `Cookie` but throws away the API's `Set-Cookie`.
  - The only API responses that reach the browser are login, logout and `GET /auth/csrf`.
  - So the browser cookie expires 24 h after login however active the user is. Meanwhile,
    `touch` keeps extending the database row, so the server thinks the session is still alive.
- **Impact**:
  - Today: active users are signed out once a day, which goes against D5.
  - M3: this will matter more, because its UI is mostly server-rendered.
- **Fix**, either option works:
  1. Relay the `Set-Cookie` header from `apiGet`. Server Components cannot set cookies, so this
     needs a middleware/proxy or a Route Handler.
  2. Make the cookie last until the absolute expiry (7 days). The database row then enforces
     the idle timeout alone.

  Option 2 is simpler and keeps the cookie and the database row consistent. Record the choice
  in ADR-0009. Add an E2E test that advances the clock.

### N2. Low — A login that overlaps a password change survives it, and can undo it

- **Where**: `AuthService.login` and `UserAdminService.setPassword`.
- **What**:
  - Login checks the password against the hash it read earlier (argon2, which takes about
    100 ms). After that it creates the session and, if `needsRehash`, writes a new hash of the
    password it was given.
  - If `user set-password` commits during that window, two things go wrong:
    1. The session revocation has already run, so the new session survives the password change.
       `SessionUserService.resolve` only checks `status`; it never compares `authenticatedAt`
       with `passwordChangedAt`.
    2. If the stored hash needed a rehash, login overwrites the new password with a hash of the
       old one.
- **Impact**: the time window is small, and accounts are created through the CLI. But
  ADR-0009 requirement 5 says a password change revokes every session.
- **Fix**:
  - In `resolve`, destroy the session when `authenticatedAt < passwordChangedAt`.
  - Make the rehash write conditional (`updateMany … where passwordHash = <hash that was read>`).

### N3. Info — ETags use millisecond timestamps that do not always increase

- **Where**:
  - `etag.ts`: the ETag is `updated_at` in epoch milliseconds.
  - Raw SQL writes set `updated_at = now()`, which is the time the _transaction started_.
  - Prisma writes set `@updatedAt` from the API process clock.
- **What**:
  - A transaction that waited for a lock can write an `updated_at` that is _earlier_ than the
    value it replaces. For example, a second `replaceAssets` that queued behind the first.
  - Two writes in the same millisecond produce the same ETag. A stale `If-Match` then passes,
    so a lost update is not detected.
  - This is unlikely with human editors, but more likely once M2+ workers write automatically.
- **Fix**, either option works:
  - Add an integer `row_version` column, incremented on every write, and use it as the ETag.
  - Write `greatest(clock_timestamp(), updated_at + interval '1 ms')`.

### N4. Info — Some checks run before the transaction

- **What**: `updateVersion` and `replaceAssets` check that the parent is active and that the
  assets are usable _before_ opening the transaction. Access checks also run outside it.
- **Effect**: a draft can still be edited (or link an asset) just after its parent or the asset
  is archived. This is harmless: approval checks both again under lock, and drafts may already
  reference assets that were archived later (decision U4). No change needed in M1. Keep it in
  mind before M2 relies on these checks for job intent.

### N5. Info — CI has never run on the M1 commits

- **What**: `.github/workflows/ci.yml` runs only on pushes to `main` and on pull requests.
  `claude/gracious-planck-kuf4pq` is pushed but has no PR.
- **Consequence**: these combinations have never been tested on M1:
  - PostgreSQL 17.12 (local runs use 16.15)
  - Node 24
  - `pnpm audit` from a clean install
- **Fix**: open a draft PR, or run the workflow manually, before M1 is signed off.

## 3. Status of earlier findings

| #   | Finding                                                                                                                   | Severity | Status                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Concurrent `PUT …/versions/:id/assets` deadlocks and merges link sets                                                     | Medium   | **Fixed** (`79360a3`). Version row is locked first; API race tests added; ADR-0011 §5 records the exception |
| 2   | `listVersions` orders by `created_at` (transaction start), so concurrent creates can list v3 after v4                     | Low      | Open. The misleading code comment is still at `versioned-entity.service.ts` (`listVersions`)                |
| 3   | `GET /auth/csrf` uses `overwrite: true`, so a second tab invalidates the first tab's token                                | Low      | Open (`csrf.service.ts`)                                                                                    |
| 4   | Login throttling is per IP only, kept in memory, and depends on a correct `TRUST_PROXY`                                   | Low      | Open. Must be fixed before any public deployment                                                            |
| 5   | Sign-out navigates away even when logout failed                                                                           | Low      | Open (`logout-button.tsx`, `finally`)                                                                       |
| 6   | Prisma `P2028` (lock wait or transaction timeout) becomes `500` instead of a retryable `503`                              | Low      | Open (`database-error.mapper.ts` has no mapping)                                                            |
| 7   | `POST …/members` shows owners whether an email has an account                                                             | Info     | Accepted for the pilot (D6)                                                                                 |
| 8   | Smaller notes: FK backstop code, N+1 link loads, `proxy.ts` reads env directly, JSON size counted in characters not bytes | Info     | Open, no action needed for M1                                                                               |

## 4. Architecture and conformance

These parts follow CLAUDE.md and the approved design:

- **Monorepo**: one modular monorepo (`apps/api`, `apps/web`, `packages/{config,contracts,database}`). There are no microservices and no M2+ scope (no providers, queues or media processing).
- **Database is the source of truth**: invariants are enforced in PostgreSQL (composite FKs, CHECKs, deferred triggers), with separate `acf_migrator` and `acf_app` roles. The API's own checks only give precise 4xx errors on top.
- **Concurrency**: lock order is documented (ADR-0011 §5, including the new exception) and race-tested. Transactions run at READ COMMITTED with one bounded retry.
- **Auth**: database sessions (only the hashed ID is stored, rows are created only at login), Origin → session → CSRF in a single guard, `__Host-` cookies in secure mode, and login fails closed if the cookie cannot be set.
- **Contracts**: Zod schemas are shared between validation and OpenAPI 3.1; errors use one envelope; ETag/`If-Match`; opaque cursors.
- **Code conventions**: strict TypeScript, thin controllers, money and time rules respected (UTC `timestamptz(3)`), no secrets in the web bundle.

Watch as the code grows:

- **`versioned-entity.service.ts` (565 lines)**: it holds parent, version, link and approval logic for two kinds of entity, mostly in raw SQL. That is fine for now. If M2+ adds more versioned kinds, split out an approval module.
- **Raw SQL**: about half of the data access bypasses Prisma's types. The integration tests cover it well, but schema renames will not be caught at compile time. Keep the drift check and the integration suite required in CI.

## 5. Test evidence (run for this review, 2026-11-17, local PostgreSQL 16.15)

| Command                                                          | Result               |
| ---------------------------------------------------------------- | -------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | Clean                |
| `pnpm test` (unit)                                               | 17 files, 140 passed |
| `pnpm test:integration` (database + API)                         | 15 files, 466 passed |
| `pnpm test:e2e` (Playwright, Chromium)                           | 5 passed             |

Tests that are missing:

- Cookie renewal across page navigations (N1)
- Login racing a password change (N2)
- Two tabs sharing one CSRF token (finding 3)
- The `503` path when the session store fails
- E2E browsers other than Chromium

## 6. Recommended actions

Before starting M2:

1. Fix N1 (recommended: a cookie that lasts until the absolute expiry, with the idle timeout
   enforced by the database row) and add an E2E test for it.
2. Open a draft PR (or trigger CI) so M1 runs on PostgreSQL 17.12 and Node 24 (N5).
3. Get the owner's review of M1e and update CLAUDE.md §12.

As one small follow-up PR, each fix with a test:

4. N2, and findings 2, 3, 5 and 6.

Before M2 workers write versioned rows:

5. N3: replace timestamp ETags with a row-version counter.

Before any public deployment:

6. Finding 4: per-account login throttling, a Redis-backed throttler, and a check of the
   proxy chain.
