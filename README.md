# AI Content Factory

A low-cost, multi-provider platform that turns a content brief into an approved, downloadable
vertical video (9:16 MP4). Every prompt, asset, job, model call and cost is recorded, and a person
approves the work at five gates.

**Status:** MVP complete (milestones M0–M8.5, 2026-11-20). See `docs/IMPLEMENTATION_PLAN.md`.

## How it works

1. Write a brief → the system generates a **script** (gate 1: approve).
2. Script → **storyboard** of 3–6 scenes (gate 2: approve).
3. One **keyframe image** per scene (gate 3: choose).
4. One **video clip** and one **voice-over** per scene (gate 4: choose).
5. FFmpeg **renders** the final MP4 with captions and music, then runs automated checks (gate 5: approve).
6. **Export** the package: MP4, SRT, thumbnail, manifest, cost report.

## Quickstart

Requires Node.js ≥ 22.12, pnpm 10, Docker and FFmpeg ≥ 5.1. Full details: `docs/LOCAL_DEVELOPMENT.md`.

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
pnpm storage:setup
```

```bash
pnpm db:seed
```

```bash
pnpm dev
```

`pnpm db:seed` creates a demo workspace and prints three demo sign-ins once. Then open
http://localhost:3000/login. Run the worker too (`pnpm dev:worker`) to generate content.

Before pushing, run every quality gate (format, lint, typecheck, unit tests, build):

```bash
pnpm check
```

## Repository layout

```text
apps/
  web/              Next.js Content Studio
  api/              NestJS REST API
  worker/           BullMQ worker: generation, media, rendering
packages/
  contracts/        Zod schemas and shared types (API boundary)
  database/         Prisma schema, migrations, integrity tests
  content-domain/   Pipeline rules: brief, script, storyboard, media, render, budgets
  ai-core/          Provider interfaces, routing, money, OpenRouter adapters, mocks
  ai-runtime/       LLM/image/video/TTS services, ledger, budgets, circuit breaker
  storage/          S3 object store, image validation, backups
  media/            FFprobe/FFmpeg: validation, captions, rendering, QC
  config/           Typed environment validation
infra/
  compose/          Local PostgreSQL, Redis, SeaweedFS
  deploy/           Staging: Dockerfile, Compose, Caddy, acf.sh, backups
docs/               Specifications, ADRs, design records
```

## Technology

TypeScript · Next.js · NestJS · PostgreSQL + Prisma · Redis + BullMQ · FFmpeg · S3-compatible
storage (SeaweedFS) · pnpm workspace. AI models are reached through OpenRouter, behind
capability-specific interfaces (LLM, image, video, TTS).

## Documents

| Document | What it covers |
|---|---|
| [PRD](docs/PRD.md) | Product goals, users, requirements, acceptance criteria |
| [Architecture](docs/ARCHITECTURE.md) | Components, runtime flow, reliability, security |
| [Content pipeline](docs/CONTENT_PIPELINE.md) | Stages, gates, statuses, reuse |
| [AI providers](docs/AI_PROVIDER_STRATEGY.md) | Provider interfaces, registry, routing, data policy |
| [Cost strategy](docs/COST_STRATEGY.md) | Money, prices, budgets, cost reports |
| [Database](docs/DATABASE.md) | Tables by area, database-enforced rules, roles |
| [API](docs/API_SPEC.md) | REST endpoints, errors, conventions |
| [Local development](docs/LOCAL_DEVELOPMENT.md) | Setup, commands, tests |
| [Deployment](docs/DEPLOYMENT.md) | Staging on one Ubuntu VPS, operations, backups |
| [UAT](docs/UAT.md) | Acceptance walk-through and results |
| [Known limitations](docs/KNOWN_LIMITATIONS.md) | What the MVP does not do |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Milestones, process, Definition of Done |
| [ADRs](docs/adr/README.md) | Architecture decisions |
| `docs/design/` | Design review packages and verification records per milestone (historical) |
| [CLAUDE.md](CLAUDE.md) | Rules for Claude Code in this repository |

Provider models, prices and terms change often. Treat the figures in these documents as recorded
at a date, and check the provider's current documentation before you rely on them.
