# AI Content Factory — Technical Specification Pack

**Version:** 1.0.0  
**Status:** Initial implementation baseline  
**Purpose:** A Claude Code-ready technical specification for building a low-cost, multi-provider AI content production platform.

## Product outcome

A user submits a content brief. The system researches and plans the content, generates a script and storyboard, creates approved image/video/audio assets, assembles a final vertical MP4, tracks actual costs, and presents the result for human approval.

The MVP is complete when one brief can reliably become one downloadable, reviewable video package with traceable prompts, assets, provider/model usage, costs, and recoverable job state.

## Documents

| File | Purpose |
|---|---|
| `docs/PRD.md` | Product requirements and acceptance criteria |
| `docs/ARCHITECTURE.md` | System architecture and module boundaries |
| `docs/DATABASE.md` | Data model and relational schema guidance |
| `docs/API_SPEC.md` | REST API contracts |
| `docs/AI_PROVIDER_STRATEGY.md` | Provider abstraction, routing, and model registry |
| `docs/CONTENT_PIPELINE.md` | End-to-end production workflow |
| `docs/COST_STRATEGY.md` | Budgeting, usage metering, and cost controls |
| `docs/IMPLEMENTATION_PLAN.md` | Milestones, task breakdown, and Definition of Done |
| `docs/LOCAL_DEVELOPMENT.md` | Exact local setup, run, test and database commands |
| `docs/adr/` | Architecture Decision Records |
| `CLAUDE.md` | Instructions for Claude Code working in this repository |

## Quickstart (M0)

Requires Node.js ≥ 22.12, pnpm 10 and Docker. Full details are in `docs/LOCAL_DEVELOPMENT.md`.

```bash
cp .env.example .env
```

```bash
pnpm install
```

```bash
pnpm infra:up
```

```bash
pnpm db:setup
```

```bash
pnpm db:seed
```

`pnpm db:seed` creates a development-only demo workspace and prints three demo sign-ins once.

```bash
pnpm dev
```

- Web: http://localhost:3000 (sign in at `/login`; status page: `/status`)
- API: http://localhost:4000/api/v1/health and `/api/v1/health/ready`

To run every quality gate (format, lint, typecheck, unit tests, build):

```bash
pnpm check
```

Integration tests run against the Docker services:

```bash
pnpm test:integration
```

### Implemented so far

| Milestone | Status |
|---|---|
| M0 — Foundation | Done: workspace, config validation, health checks, Prisma bootstrap, ADRs |
| M1 — Domain, persistence, identity & access | Done and approved (design revision 4, slices M1a–M1e) |
| M2 — AI core and model registry | Done and approved |
| M3 — Script and storyboard pipeline (+ R0 content masters) | Done and approved |
| M4 — Image and asset management | Done and approved |
| M4.5 — UI/UX refinement | Done and approved (`docs/design/M4.5-ui-refinement.md`) |
| M5 — Video and audio generation | Done and approved (2026-11-19); benchmark run, real models routed |
| M6 — Rendering and export | Slices M6a–M6d delivered (`docs/design/M6-design-review-package.md` §16, ADR-0018); awaiting review |
| M7–M8 | Not started |

## Decisions fixed for MVP

- Monorepo with modular architecture; do not start with microservices.
- Frontend: Next.js + TypeScript.
- Backend: NestJS + TypeScript.
- Database: PostgreSQL + Prisma.
- Queue: Redis + BullMQ.
- Workflow automation: n8n is optional integration/orchestration support, not the source of truth for production state.
- Media processing: FFmpeg worker.
- Storage: S3-compatible object storage (Cloudflare R2 is a candidate).
- AI providers are accessed through capability-specific adapters.
- LLM gateway and image/video/TTS providers are separate concerns.
- All generated media and jobs must be traceable and resumable.
- Human approval is required before final export is marked approved or content is published.

## Important implementation note

Provider capabilities, model IDs, pricing, free-tier quotas, API schemas, and usage terms change frequently. Do not hardcode claims from this document as current facts. Before implementing a provider adapter, verify its official API documentation, supported capabilities, pricing, data retention/training terms, and rate limits. Store model pricing as configurable registry data with an effective date.

## Repository layout

The layout below is the target. Packages and apps are added in the milestone that needs them.
After M0 the repository contains `apps/api`, `apps/web`, `packages/config`, `packages/contracts`,
`packages/database`, `infra/compose` and `docs/adr`.

```text
ai-content-factory/
├── apps/
│   ├── web/                  # Next.js dashboard
│   ├── api/                  # NestJS REST API
│   └── worker/               # BullMQ workers
├── packages/
│   ├── contracts/            # Shared DTOs, schemas, enums
│   ├── database/             # Prisma schema and migrations
│   ├── ai-core/              # Provider interfaces, routing, usage
│   ├── content-domain/       # Content/script/storyboard domain
│   ├── media/                # FFmpeg and media validation
│   └── config/               # Shared config and environment validation
├── workflows/
│   └── n8n/                  # Optional workflow exports
├── infra/
│   ├── docker/
│   └── compose/
├── docs/
├── .env.example
├── pnpm-workspace.yaml
├── package.json
└── CLAUDE.md
```

## First implementation command

Ask Claude Code to read `CLAUDE.md` and all documents in `docs/`, then implement **Milestone M0 only**: repository skeleton, architecture decisions, environment validation, local Docker Compose, health checks, and a short ADR log. Do not build the full pipeline in one pass.
