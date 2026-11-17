# ADR-0009: Authentication strategy

- Status: **Accepted** (strategy: owner review 2026-11-17). Session-store design (D2):
  **conditionally approved**; the final design is in the M1 design review package, pending approval.
- Date: 2026-11-17
- Milestone: M0 (decision), M1 (implementation)

## Context

`docs/API_SPEC.md` required the session/JWT strategy to be chosen in M0, and all non-health
endpoints must be protected outside local environments. `docs/PRD.md` defines the roles
Owner/Admin, Editor and Viewer. Provider secrets must never reach the browser.

## Decision

Approved requirements:

1. **Server-side sessions stored in PostgreSQL.** The browser holds only an opaque, signed
   session ID.
2. **HttpOnly cookie**, `SameSite=Lax`, `Secure` in production with the `__Host-` prefix,
   `Path=/`, no `Domain`.
3. **CSRF protection** for state-changing requests.
4. **Project-level RBAC** (`owner`, `editor`, `viewer`), enforced in service methods, never only
   in the frontend. Non-members get 404.
5. **Immediate revocation** on logout, and revocation of all of a user's sessions on password
   change or account disable.
6. **Mature, maintained libraries**; no hand-written cryptographic or session primitives.
7. **Browser topology**: the browser talks only to the Next.js origin, which rewrites `/api/v1/*`
   to the private API.

### Session store (D2, conditional approval)

- **express-session 1.19.0** owns the session lifecycle and cookie semantics:
  - ID generation (`uid-safe`, 192-bit);
  - cookie signing with rotatable secrets;
  - `regenerate` on login (fixation defence);
  - `destroy` on logout;
  - the rolling cookie.
- A **persistence-only `PrismaSessionStore extends session.Store`** keeps rows in `sessions`:
  - The primary key is `id_hash = SHA-256(sessionID)` via `node:crypto`. The raw ID is never
    stored.
  - The payload is allow-listed to `{cookie, userId, authenticatedAt}`.
  - Rows carry `expires_at` (24 h idle, rolling) and `absolute_expires_at` (7 d, never extended).
    `get` treats expired rows as absent.
  - `touch` is UPDATE-only, so an in-flight request cannot resurrect a destroyed session.
  - `destroyAllForUser` revokes every session for that user.
- **Passwords**: `argon2` 0.45.2 (Argon2id, PHC strings, rehash on login when parameters change).
- **CSRF**: `csrf-csrf` 4.1.0 (signed double-submit bound to the session ID) plus an Origin /
  `Sec-Fetch-Site` check on every unsafe method, including login.
- **Login throttling**: `@nestjs/throttler`. **Security headers**: `helmet`.
- **Production rules**:
  - Config rejects `SESSION_COOKIE_SECURE=false` with `NODE_ENV=production`.
  - `TRUST_PROXY` must name the Next.js hop.
  - The TLS proxy must overwrite `X-Forwarded-Proto`.
  - Login fails closed if a Secure cookie could not be set.

Verified on NestJS 12.3.2 (Express 5.3.0) through a Next.js 16.4.6 rewrite: 25/25 behavioural
checks (see `docs/design/m1/evidence/`).

## Consequences

- Every authenticated request costs one indexed session lookup plus one user lookup. Touch
  writes are throttled to one per 60 s per session.
- Roles are read from the database per request, so changes apply immediately.
- The store is application code. It is covered by integration tests for expiry, logout, invalid
  sessions, fixation and concurrency.

## Alternatives rejected

- **Stateless JWT bearer tokens**: revocation is hard, and tokens stored in the browser are
  exposed to XSS.
- **Single static admin token**: no roles, easy to leak.
- **`connect-pg-simple`**: stores the raw session ID as the key, has no user FK, and can't
  revoke all sessions for a user without JSON queries.
- **Better Auth**: owns the user/session schema and HTTP routes, has its own error format, and
  its NestJS integration is third-party. Heavier than local accounts need.
