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
