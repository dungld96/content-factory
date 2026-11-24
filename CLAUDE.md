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

The MVP is complete: M0–M8.5 are done and approved (2026-11-20). Details per milestone:
`docs/IMPLEMENTATION_PLAN.md` §2 and the design packages in `docs/design/`.

Post-MVP: audit `docs/post-mvp/POST_MVP_AUDIT.md` (owner decisions recorded there). **P3 —
Worker monitoring & smart recovery:** design package revision 1 approved
(`docs/design/P3-design-review-package.md`; W1–W6, 2026-11-20); slices P3a–P3c implemented,
integration/E2E verification pending (package §10).
**P2a — Asset Library integrity:** design package revision 1 approved
(`docs/design/P2a-design-review-package.md`; A1–A3, 2026-11-20); slices P2a-1–P2a-3 implemented,
API integration/E2E verification pending (package §9).
**P2b — Asset Library features:** design package revision 1 approved
(`docs/design/P2b-design-review-package.md`; L1–L6, collections per project); slices
P2b-1–P2b-4 implemented, API integration/E2E verification pending (package §10).
**P1 — OpenRouter Settings UI:** design package revision 1 approved
(`docs/design/P1-design-review-package.md`; O1–O7); slices P1a–P1c implemented, API
integration/E2E verification pending (package §10). Operators: `OPERATOR_EMAILS`.
**P4 — Audio configuration:** design package revision 1 approved
(`docs/design/P4-design-review-package.md`; S1–S7); slices P4a–P4c implemented, API
integration/E2E verification pending (package §9). Renders without `audio` stay `render.v1`.

**2026-11-21 follow-ups (owner: "decide by recommendation until done"):**
P3d — keep paid media when a later step fails (`docs/design/P3d-design-review-package.md`; tool
check before paying, delivered output stored before validation, finish without a new charge);
UX review U1–U8 (`docs/design/UX-review-package.md`; Scenes board, Next step, phone shell,
foundations, `lucide-react` icons); P4d — voice-over on/off per content item (P4 package §11);
P2c — picker uploads into the Library (P2b package §11); P1d — model import and prices in
Settings (P1 package §11); product photos in the brief, sent with every keyframe (P2b package
§12). All implemented; unit, integration and E2E suites pass except the
backup drill, which fails on the local SeaweedFS running out of volumes (environment).

**2026-11-23 redesign R (owner approved R-D1–R-D6; "làm tới khi xong toàn bộ"):** design package
`docs/design/R-redesign-package.md` (visual design in the linked canvas). Bilingual UI (EN/VI,
`lib/i18n/`, every UI string through `t()`), 7-entry menu with To-do as home, Productions
(list/board), workspace Costs, stage rail + Next-step bar + history drawer, review mode for the
gates, live job events over SSE (ADR-0022) with a Jobs tray, configurable cost-confirmation
threshold, settings sub-routes. All slices implemented; lint, typecheck, unit, build, live/auth
integration and E2E (EN, VI, phone) pass.

Open items:
- Off-server backups wait for the backup destination (rclone remote).
- The paid image benchmark (G2) waits for an OpenRouter API key.
- Staging targets a generic Ubuntu VPS (ADR-0021). After deploys run `pnpm media:selftest` in the
  image (Debian FFmpeg 5.1).

Routed models (pilot): scripts Gemini 3.5 Flash Lite, storyboards Claude Haiku 5.5, images
Seedream 5.0 Flash, clips Veo 3.1 Lite, voice per voice profile.

Read before working in an area:

| Area | Read |
|---|---|
| Domain, persistence, auth (M1) | `docs/design/M1-design-review-package.md`, ADR-0009 to ADR-0011 |
| AI core, registry, money (M2) | `docs/design/M2-design-review-package.md`, `docs/design/m2/`, ADR-0012 |
| Storage, images (M4) | `docs/design/M4-design-review-package.md` §12, ADR-0006, ADR-0016 |
| Video, audio (M5) | `docs/design/M5-design-review-package.md`, `docs/design/m5/openrouter-video-tts-verification.md` |
| Rendering, export (M6) | `docs/design/M6-design-review-package.md` |
| Budgets, reliability (M7) | `docs/design/M7-design-review-package.md` |
