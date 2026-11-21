# ADR-0001: Monorepo with modular architecture

- Status: Accepted
- Date: 2026-11-17
- Milestone: M0

## Context

The MVP needs a web dashboard, a REST API and background workers that share domain types,
validation schemas and configuration. The team is small, and the specs (`README.md`,
`docs/ARCHITECTURE.md`) fix a modular monorepo for the MVP and forbid microservices without an ADR.

## Decision

- One pnpm workspace repository with `apps/*` (deployable processes) and `packages/*` (libraries).
- Deployables: `apps/web` (Next.js), `apps/api` (NestJS), and `apps/worker` (BullMQ consumers,
  added when the first job type lands — M2/M3). API and worker are separate **processes** from the
  same codebase, not separate services.
- Shared packages are created when first needed, not as empty stubs. M0 creates `config`,
  `contracts` and `database`. `ai-core`, `content-domain` and `media` arrive with M2–M6.
- Package dependency direction: `apps → packages`; packages never import from apps.
  `contracts` and `config` depend on nothing internal.
- Internal packages compile to `dist/` with `tsc` and are consumed through `package.json`
  `exports`. Root scripts build packages before dependents (`pnpm build:packages`).

## Consequences

- One lockfile, one toolchain, atomic cross-cutting changes.
- Packages must be built before apps typecheck/test; root scripts do this automatically.
- No build orchestrator (Turborepo/Nx) yet. Revisit if build times become a problem.

## Alternatives considered

- **Microservices** — rejected for MVP: operational cost without measured need.
- **Source-only internal packages (no build step)** — simpler dev loop, but NestJS needs compiled
  JS with decorator metadata and Node cannot run the TS sources directly. Rejected for now.
