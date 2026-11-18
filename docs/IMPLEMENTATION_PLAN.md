# Implementation Plan

## 1. Delivery strategy

Implement in vertical slices. Each milestone must leave the application runnable and testable. Do not generate the entire codebase in one Claude Code task.

## 2. Milestones

### M0 — Foundation
Deliverables:
- Monorepo and package manager setup.
- TypeScript configuration.
- Lint, format, test setup.
- Docker Compose for PostgreSQL and Redis.
- Environment validation.
- NestJS health endpoint.
- Next.js shell.
- Prisma initial setup.
- ADR directory and first decisions.

Acceptance:
- One command starts local dependencies.
- Web and API start.
- Health checks pass.
- No secrets committed.

### M1 — Domain and persistence
Deliverables:
- Initial Prisma schema.
- Project/content/character/environment/asset/job entities.
- Migrations and seed data.
- Repository/service patterns.
- API CRUD for projects and content.

Acceptance:
- Migrations work on empty DB.
- Integration tests cover core CRUD.
- Authorization boundaries are defined.

Delivery: the design in `docs/design/M1-design-review-package.md` (revision 4) is implemented in
five reviewed slices: M1a database foundation, M1b API foundation and auth, M1c
projects/members/channels/content, M1d characters/environments/versions/assets, M1e seed,
permission matrix, web and docs (package §12).

M1 acceptance evidence: the `init_m1` migration builds every test database from empty
(`integration:database`, `integration:api`, E2E); integration tests cover CRUD for every M1
resource; authorization boundaries are a table-driven matrix over every route and five callers
(`apps/api/test/workspace/permission-matrix.integration.test.ts`); Playwright covers
login → projects → logout through the same-origin proxy.

### M2 — AI core and model registry
Deliverables:
- Capability interfaces.
- Provider registry.
- Model registry.
- One LLM adapter.
- Usage/cost normalization.
- Provider configuration validation.
- Mock providers for automated tests.

Acceptance:
- Business logic uses interfaces, not vendor SDKs.
- Mock tests do not make paid calls.
- Provider errors are normalized.

Delivery: `docs/design/M2-design-review-package.md` (revision 1, approved), slices M2a–M2d.

M2 acceptance evidence: business code depends only on `@acf/ai-core` interfaces (ESLint forbids
the vendor subpath outside `apps/api/src/ai/providers`; no vendor SDK is installed); no test can
reach a real host (network guard) and the paid smoke test is manual, opt-in and cost-capped;
every documented OpenRouter error class is normalized and covered by contract tests
(`packages/ai-core/src/openrouter/contract.test.ts`).

### M3 — Script and storyboard pipeline
Deliverables:
- Brief validation.
- Research adapter (optional source search provider).
- Script generation.
- JSON schema validation.
- Storyboard generation.
- Versioning and approval endpoints/UI.

Acceptance:
- A brief produces valid script/storyboard JSON.
- Invalid model output is repaired/rejected safely.
- User edits create a new version.

Delivery: `docs/design/M3-design-review-package.md` (revision 1, approved), ADR-0013, slices
M3a–M3e. Owner decisions: no research provider (F2); the content plan is part of the script (F3).

M3 acceptance evidence: a brief produces schema- and rule-valid script and storyboard JSON
through the asynchronous job path (API → PostgreSQL intent → BullMQ → `apps/worker` → LLM →
versions), end to end in `apps/web/e2e/pipeline.spec.ts`; invalid model output gets one repair
call, then fails with `OUTPUT_INVALID` (`apps/worker/test/processor.integration.test.ts`); every
edit creates a new immutable version and approved versions cannot change (`AC012`/`AC013`,
`packages/database/test/artifacts.integration.test.ts`, API integration tests).

### M3.5 / R0 — Multi-format foundation
Design: `docs/design/M3.5-multiformat-architecture-review.md` (approved), ADR-0015.

Delivered in slice R0: content masters (`content_masters`, 1:1 backfill), content items as
variants (`content_master_id`, `target_platform`, `master_brief_revision`), format and platform
registries with a compatibility check in `packages/content-domain`, master/variant endpoints.
No change to M3 generation. Later steps (R1–R4) are in the review §7.

### M4 — Image and asset management
Deliverables:
- Image provider adapter.
- Reference asset upload.
- Image generation jobs.
- Asset lineage.
- Candidate review/approval UI.

Acceptance:
- At least one configured provider generates an image.
- Output stored in object storage.
- Asset links to prompt, model, inputs, and job.

Delivery: `docs/design/M4-design-review-package.md` (revision 1, approved), ADR-0016,
ADR-0006 (amended), slices M4a–M4e. Owner decisions G1–G9: OpenRouter Image API with a capped
benchmark before routing a real model; SeaweedFS 4.54 for local/CI/staging storage; bytes through
the API.

M4 acceptance evidence: an image provider generates images through the `ImageProvider` interface
(contract tests against the documented OpenRouter Image API; mock provider in CI; the paid,
capped `pnpm ai:registry smoke-image` for a real model once a key is set); the worker stores each
image in object storage and the test reads it back with a matching checksum
(`apps/worker/test/image-processor.integration.test.ts`, real SeaweedFS); every generated asset
links its job (prompt snapshot, model, input), its scene and its reference inputs (`asset_inputs`),
and its job's invocations carry the cost (`apps/api/test/generation/images.integration.test.ts`,
`packages/database/test/images.integration.test.ts`); end to end in the browser:
`apps/web/e2e/pipeline.spec.ts` (generate → approve → keyframes → gate 3) and
`apps/web/e2e/masters.spec.ts` (content masters, variants, reference upload).

### M5 — Video and audio generation
Deliverables:
- Video provider adapter.
- Async job submission and polling/webhook path.
- TTS adapter or audio import.
- Scene-level retries.
- Usage/cost records.

Acceptance:
- Video job completes or returns a clear actionable error.
- Worker restart does not lose provider job tracking.
- Retry does not duplicate completed scenes.

### M6 — Rendering and export
Deliverables:
- FFmpeg worker.
- Media normalization.
- Subtitle/audio mix.
- Final MP4 export.
- Preview/download.

Acceptance:
- Valid 9:16 MP4 produced from approved scenes.
- Metadata and cost report included.
- Final export has approval state.

### M7 — Reliability and cost controls
Deliverables:
- Budget enforcement.
- Retry/backoff.
- Dead-letter queue.
- Job event history.
- Monitoring and logs.
- Provider circuit breaker.

Acceptance:
- Hard budget blocks expensive work.
- Failed jobs can resume.
- Logs redact credentials.
- Costs distinguish reported vs estimated.

### M8 — Pilot and hardening
Deliverables:
- Pilot content project.
- Benchmark report.
- User acceptance testing.
- Backup/restore procedure.
- Deployment documentation.
- Known limitations list.

Acceptance:
- One complete content item reaches approved export.
- Cost per output is measured.
- Failures and manual interventions are documented.

## 3. Testing strategy

- Unit tests: routing, cost calculations, prompt builders, state transitions.
- Contract tests: provider adapters using fixtures/mocks.
- Integration tests: PostgreSQL, Redis, object storage.
- End-to-end tests: project → content → script/storyboard → mocked media → render.
- Paid smoke tests: manually enabled, budget capped, never part of default CI.
- Media tests: FFprobe validates codec, dimensions, duration, and audio streams.

## 4. Claude Code execution protocol

For each milestone:
1. Read `CLAUDE.md` and relevant docs.
2. Inspect the current repository before editing.
3. Propose a short implementation plan.
4. Implement only the selected milestone.
5. Run lint, typecheck, unit tests, and relevant integration tests.
6. Summarize changed files, decisions, tests, and remaining risks.
7. Update docs/ADR when architecture changes.
8. Wait for user review before starting the next milestone.

## 5. Definition of Done per task

- Code follows project conventions.
- Input validation exists.
- Errors are handled and observable.
- Tests cover success and failure paths.
- No secret or real API key in code/tests.
- Database changes have migrations.
- API changes update OpenAPI docs.
- User-visible behavior has loading/error/empty states.
- Documentation is updated.
