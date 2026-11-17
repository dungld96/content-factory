# ADR-0002: PostgreSQL as the source of truth

- Status: Accepted
- Date: 2026-11-17
- Milestone: M0

## Context

Production runs span many asynchronous jobs, provider calls and human approvals. State must
survive restarts of the API, workers and Redis, and must be auditable (cost, lineage, approvals).

## Decision

- PostgreSQL holds all production state: projects, content, versions, jobs, job events, usage,
  budgets, approvals, asset metadata.
- Prisma ORM 7 is the access layer (`packages/database`), using the `prisma-client` generator
  (ESM, generated into `packages/database/src/generated`, git-ignored) and the `@prisma/adapter-pg`
  driver adapter, as required by Prisma 7. Connection URLs live in `prisma.config.ts`.
- Redis, BullMQ and n8n never hold the only copy of any state.
- Every schema change is a Prisma migration; applied migrations are never edited.
- Timestamps are stored in UTC; money as integer micros or `Decimal`.
- Local development uses PostgreSQL 17 (`postgres:17.12-alpine`).

## Consequences

- Job intent is persisted before enqueueing; workers reconcile from the database after restart.
- The `prisma generate` step is part of `@acf/database`'s build.
- M0 ships no models; M1 adds the first migration (see `docs/DATABASE.md`).

## Alternatives considered

- Prisma 8 — only release candidates are published (`latest` dist-tag points to an RC). Rejected
  until a stable release.
- TypeORM/Drizzle — not in the fixed technology baseline.
