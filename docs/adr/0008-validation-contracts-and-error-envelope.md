# ADR-0008: Zod contracts, environment validation and error envelope

- Status: Accepted for M0 — **review requested**
- Date: 2026-11-17
- Milestone: M0

## Context

`docs/API_SPEC.md` allows "Zod or class-validator" for DTO validation and defines an error
envelope. `CLAUDE.md` requires validated environment configuration, validation at boundaries,
typed contracts, correlation IDs and secret redaction.

## Decision

- **Zod** is the single validation library. Shared schemas live in `packages/contracts` and are
  used by both API (request/response validation) and web (response parsing). class-validator is
  not used.
- **Environment** is validated by Zod schemas in `packages/config` (`loadApiEnv`,
  `loadWebServerEnv`). The API validates **before** Nest boots and exits with code 1 on failure.
  Error messages list variable names and problems only, never values. `scripts/check-env.mjs`
  (`pnpm env:check`) validates without starting anything.
- Web env is server-only (`server-only` guard). No secrets in `NEXT_PUBLIC_*`.
- **Error envelope**: a global `ApiExceptionFilter` maps every error to
  `{ error: { code, message, retryable, correlationId } }`. Unknown errors become
  `500 INTERNAL_ERROR` with a generic message; stacks go only to server logs.
- **Correlation IDs**: `x-correlation-id` is accepted from the caller only if it matches
  `[A-Za-z0-9._-]{8,128}`, otherwise generated (UUID). It is echoed in the response and included in
  log lines and error bodies.
- **Logging**: Nest `ConsoleLogger`, JSON mode via `LOG_JSON=true`. Request logs include method,
  path (without query string), status, duration and correlation ID. They never include headers or
  bodies.
- **API base path** is `/api/v1`. Health endpoints: `GET /api/v1/health` (liveness, no dependency
  I/O) and `GET /api/v1/health/ready` (PostgreSQL + Redis, `503` when any check fails). Probe errors
  are reduced to `unreachable` or `timeout` so driver messages (hosts, usernames) never reach clients.

## Consequences

- OpenAPI generation from Zod (e.g. `nestjs-zod` or `zod-openapi`) must be chosen in M1, when the
  first CRUD endpoints arrive. M0 has only health endpoints, which are documented in `docs/API_SPEC.md`.
- A Nest validation pipe for Zod schemas is added in M1.
