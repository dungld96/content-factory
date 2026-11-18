# CLAUDE.md — AI Content Factory

## 1. Project mission

Build a low-cost, multi-provider AI content production platform. Read `README.md` and the relevant documents in `docs/` before making architectural or domain changes.

The MVP converts a content brief into an approved, downloadable vertical MP4 with traceable prompts, assets, jobs, provider/model usage, and cost.

## 2. Non-negotiable engineering principles

1. Use the documented modular monorepo architecture.
2. Do not introduce microservices without an explicit ADR and user approval.
3. Keep business logic provider-agnostic.
4. Use capability-specific provider interfaces; do not assume every provider supports every media capability.
5. PostgreSQL is the source of truth for production state.
6. BullMQ/Redis is transport/queue infrastructure, not the source of truth.
7. All expensive operations must be asynchronous jobs.
8. All generation operations must be idempotent and traceable.
9. Never regenerate successful upstream stages unnecessarily.
10. Never overwrite approved master/reference assets; create versions.
11. Human approval is required at defined gates.
12. Never expose provider API keys to frontend code or logs.
13. Unknown cost is not zero cost.
14. Free-tier quotas are not guaranteed production capacity.

## 3. Required workflow before coding

- Inspect repository structure and existing conventions.
- Read relevant specification sections.
- Identify assumptions and missing provider capabilities.
- Present a concise plan for the requested milestone.
- Implement only the agreed scope.
- Run lint, typecheck, tests, and build checks.
- Report changed files, test results, risks, and follow-up tasks.

Do not rewrite unrelated modules or perform broad refactors without approval.

## 4. Technology baseline

- TypeScript.
- Next.js for web.
- NestJS for API.
- PostgreSQL + Prisma.
- Redis + BullMQ.
- FFmpeg for media processing.
- S3-compatible object storage.
- n8n as optional integration/orchestration support.
- pnpm workspace unless repository inspection gives a strong reason to change.

Pin dependency versions and use currently supported stable releases. Do not invent package versions; verify compatibility before installation.

## 5. Code conventions

- Strict TypeScript; avoid `any`.
- Validate external input at boundaries.
- Keep controllers thin.
- Put domain rules in services/domain modules.
- Use dependency injection for provider adapters.
- Use typed result/error contracts.
- Use structured logs with correlation IDs.
- Redact secrets and sensitive headers.
- Use UTC timestamps in persistence; render user timezone in UI.
- Use integer micros or Decimal for money.
- Use explicit enums for job/stage states.
- Avoid hidden side effects in constructors.

## 6. Provider integration rules

Before implementing an adapter:
1. Verify official provider documentation.
2. Verify current model IDs and supported parameters.
3. Verify pricing and pricing units.
4. Verify rate limits and async lifecycle.
5. Verify data retention/training terms.
6. Implement request/response normalization.
7. Add fixture-based contract tests.
8. Add a mock implementation for local tests.

Do not claim a provider is free unless its current official terms support that claim. Do not route to a model unless it supports the requested capability and parameters.

## 7. Job and queue rules

- Persist job intent before enqueueing.
- Use idempotency keys.
- Persist provider job IDs.
- Record state transitions.
- Use bounded retries with exponential backoff and jitter.
- Do not retry invalid requests, policy blocks, authentication failures, or budget blocks.
- Handle worker restarts and orphaned provider jobs.
- Use a dead-letter queue after retry exhaustion.
- Support scene-level retry and production-run resume.

## 8. Media rules

- Validate MIME type and file size.
- Store binaries in object storage, not PostgreSQL.
- Use FFprobe to inspect media.
- Use FFmpeg with safe argument construction; do not interpolate untrusted shell strings.
- Keep source assets immutable.
- Store output metadata, checksum, dimensions, duration, and lineage.
- Default vertical output: 9:16, MP4, H.264, AAC, 1080x1920 when source quality permits.
- Never upscale or claim quality improvements without validating the actual result.

## 9. Testing rules

- Unit tests for domain logic, routing, cost, and state machines.
- Mock provider calls in CI.
- No paid API calls in standard automated tests.
- Contract tests for provider adapters.
- Integration tests for PostgreSQL/Redis.
- E2E tests for the complete workflow using mocked media providers.
- Paid smoke tests must be manually enabled and budget-capped.

## 10. Documentation rules

Update the relevant docs when:
- API contracts change.
- Database schema changes.
- Provider capabilities/pricing assumptions change.
- A new architectural dependency is introduced.
- A milestone acceptance criterion changes.

Record material architecture decisions in `docs/adr/`.

## 11. Scope control

Do not implement direct social publishing, multi-tenant SaaS billing, fine-tuning, livestream avatars, or large-scale analytics in MVP unless explicitly requested.

Do not build all milestones in one task. Implement one milestone at a time and wait for review.

## 12. Project status

- **M0 — Foundation:** done and reviewed.
- **M1 — Domain, persistence, identity & access:** done and approved (design revision 4, slices M1a–M1e).
- **M2 — AI core and model registry:** done and approved (design revision 1, slices M2a–M2d).
- **M3 — Script and storyboard pipeline:** design package revision 1 approved (`docs/design/M3-design-review-package.md`, ADR-0013); delivered in slices M3a–M3e (package §13). All slices done; **M3 done and approved (2026-11-18)**.
- **M3.5 — Multi-format architecture review:** approved (`docs/design/M3.5-multiformat-architecture-review.md`, §8, ADR-0015). Slice R0 (content masters, variants, format/platform registries) **done and approved (2026-11-18)**.
- **M4 — Image and asset management:** design package revision 1 approved (`docs/design/M4-design-review-package.md`, verification record `docs/design/m4/`, ADR-0016, ADR-0006 amended); delivered in slices M4a–M4e (package §11–§12). All slices done; **M4 implemented, awaiting review**. The paid image benchmark (G2) waits for an OpenRouter API key.
- **M5–M8:** not started.

Before M1-area work, read `docs/design/M1-design-review-package.md` and ADR-0009 to ADR-0011. Before M2 work, read `docs/design/M2-design-review-package.md`, its verification record and ADR-0012. Before M4-area work (storage, images), read `docs/design/M4-design-review-package.md` §12, ADR-0006 and ADR-0016.
