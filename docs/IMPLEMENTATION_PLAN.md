# Implementation Plan

## 1. Approach

Build in vertical slices. Each milestone leaves the application runnable and tested, has a design
review package approved before coding, and is reviewed before the next starts.

## 2. Milestones

All MVP milestones are done and approved. Scope, decisions and acceptance evidence for each are in
its design package in `docs/design/`.

| Milestone | Delivered | Design | Done |
|---|---|---|---|
| M0 Foundation | Workspace, toolchain, env validation, health checks, Prisma, Docker Compose, ADRs | — | 2026-11-17 |
| M1 Domain, persistence, identity | Projects, members, channels, content, characters, environments, versioned assets; sessions and roles; database-enforced integrity | `M1-design-review-package.md` (rev. 4) | 2026-11-17 |
| M2 AI core and registry | Capability interfaces, OpenRouter LLM adapter, model/price registry, usage ledger, exact money | `M2-design-review-package.md` | 2026-11-17 |
| M3 Script and storyboard | Brief validation, async jobs and worker, script and storyboard generation, versions, gates 1–2 | `M3-design-review-package.md` | 2026-11-18 |
| M3.5 / R0 Multi-format foundation | Content masters and variants, format and platform registries | `M3.5-multiformat-architecture-review.md` | 2026-11-18 |
| M4 Images and assets | Object storage, uploads, image generation, lineage, keyframes (gate 3) | `M4-design-review-package.md` | 2026-11-19 |
| M4.5 UI refinement | Content Studio redesign | `M4.5-ui-refinement.md` | 2026-11-19 |
| M5 Video and audio | Async video jobs, TTS, voice profiles, audio uploads, gate 4 | `M5-design-review-package.md` | 2026-11-19 |
| M6 Rendering and export | FFmpeg render, captions, music, QC, gate 5, export package | `M6-design-review-package.md` | 2026-11-20 |
| M7 Reliability and cost | Budgets with reservations, circuit breakers, resume, dead-letter, Costs and Operations pages, log redaction | `M7-design-review-package.md` | 2026-11-20 |
| M8 Pilot and hardening | Real-provider pilot, UAT, backup/restore, deployment docs, known limitations | `M8-design-review-package.md` | 2026-11-20 |
| M8.5 Production polish | Clip-length storyboards, voice picker, phrase captions, CSP, scheduled off-server backups, VPS staging | `M8.5-design-review-package.md` | 2026-11-20 |

Open items:
- Off-server backups need a backup destination (rclone remote) to be named.
- Paid image benchmark G2 waits for an OpenRouter API key.
- Owner UAT run on staging (`docs/UAT.md`, run 2).

Not in the MVP: direct social publishing, multi-tenant billing, fine-tuning, livestream avatars,
large-scale analytics, formats other than short vertical video.

## 3. Testing

| Kind | Scope | Command |
|---|---|---|
| Unit | Domain rules, routing, cost, state machines, prompt builders | `pnpm test` |
| Contract | Provider adapters against documented fixtures | `pnpm test` |
| Integration | PostgreSQL, Redis, object storage, worker, API | `pnpm test:integration` |
| End-to-end | Browser: project → content → script/storyboard → mocked media → render | `pnpm test:e2e` |
| Media | FFprobe checks codec, dimensions, duration, audio | in unit/integration; `pnpm media:selftest` |
| Paid smoke | One real call, capped, manual only | `ACF_PAID_SMOKE=1 pnpm ai:registry smoke…` |

No test may reach a real provider (network guard in `test-support/network-guard.ts`).

## 4. Process per milestone

1. Read `CLAUDE.md` and the relevant docs.
2. Inspect the repository.
3. Write a design review package; wait for approval.
4. Implement in slices, only the agreed scope.
5. Run `pnpm check`, integration and relevant E2E tests.
6. Report changed files, tests, risks and follow-ups; update docs and ADRs.
7. Wait for review before the next milestone.

## 5. Definition of Done

- Follows project conventions; strict TypeScript, no `any`.
- Input validated at boundaries.
- Errors handled, typed and observable.
- Tests cover success and failure paths.
- No secrets or real API keys in code or tests.
- Schema changes have migrations.
- API changes update the `@Endpoint` contracts (OpenAPI) and `docs/API_SPEC.md`.
- UI has loading, error and empty states.
- Documentation updated.
