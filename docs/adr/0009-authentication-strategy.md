# ADR-0009: Authentication strategy

- Status: **Accepted** (2026-11-17, project owner review of M0)
- Date: 2026-11-17
- Milestone: M0 (decision), M1 (implementation)

## Context

`docs/API_SPEC.md` required the session/JWT strategy to be chosen in M0, and all non-health
endpoints must be protected outside local environments. `docs/PRD.md` defines the roles
Owner/Admin, Editor and Viewer. Provider secrets must never reach the browser.

## Decision

Approved requirements:

1. **Server-side sessions stored in PostgreSQL.** The browser holds only an opaque session ID.
2. **HttpOnly cookie**; `Secure` in production; `SameSite=Lax`.
3. **CSRF protection** for state-changing requests.
4. **Project-level RBAC**: `owner`, `editor`, `viewer`, enforced at the API/service layer (never
   only in the frontend).
5. **Immediate revocation on logout**: the session row is deleted, so the next request with that
   cookie is unauthenticated.
6. **Mature, maintained libraries** for session handling, password hashing and CSRF tokens. No
   hand-written cryptographic or session primitives (ID generation, cookie signing, hashing, token
   comparison).

The concrete library selection and session lifecycle are specified in the M1 design proposal
(`docs/design/M1-domain-auth-proposal.md`). They are recorded in this ADR once approved.

## Alternatives rejected

- **Stateless JWT bearer tokens**: revocation is hard, and tokens stored in the browser are
  exposed to XSS.
- **Single static admin token**: no roles, easy to leak.
