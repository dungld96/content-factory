# ADR-0009: Authentication strategy

- Status: **Proposed — needs a decision from the project owner before M1 endpoints ship**
- Date: 2026-11-17
- Milestone: M0 (decision requested), implementation M1

## Context

`docs/API_SPEC.md` says the "session/JWT strategy [is] to be selected during M0" and that all
non-health endpoints must be protected outside local environments. `docs/PRD.md` defines roles
Owner/Admin, Editor and Viewer, and allows "simple" auth for a single-user MVP as long as provider
secrets never reach the browser. M1's acceptance requires authorization boundaries to be defined.

M0 ships only public health endpoints, so no auth code was written.

## Proposal

1. **Server-side sessions** with an opaque session ID in an `HttpOnly; Secure; SameSite=Lax`
   cookie. Session records live in PostgreSQL, so they can be revoked and audited. The web app
   calls the API through Next.js server components and route handlers, forwarding the cookie.
2. Authentication: email + password (Argon2id) for the MVP's single operator or small team,
   bootstrapped by a seed/CLI command. OAuth/OIDC can be added later behind the same session layer.
3. Authorization: role per user per project (`owner`, `editor`, `viewer`), enforced in a Nest guard
   plus service-level checks. Viewers cannot trigger paid generation or approvals.
4. CSRF protection for cookie-authenticated mutating requests (SameSite plus a CSRF token or
   Origin check).
5. A rate limit on login and on expensive endpoints.

## Alternatives

- **Stateless JWT (bearer)**: simpler to scale, but revocation is harder, and storing tokens in
  the browser increases XSS exposure. Little benefit for a single-region MVP.
- **Managed auth (Auth.js / Clerk / etc.)**: faster to start, but adds an external dependency and
  data-processing terms.
- **Single static admin token for MVP**: the smallest option, but it does not support roles and
  is easy to leak.

## Decision needed

Choose the session vs JWT strategy and the identity source (local accounts vs OIDC provider).
