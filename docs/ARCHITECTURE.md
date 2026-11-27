# System Architecture

## 1. Style

A **modular monorepo** (ADR-0001): one codebase, deployed as separate processes (web, API,
worker). No microservices without an ADR and owner approval.

## 2. Components

| Component | Role |
|---|---|
| `apps/web` (Next.js) | Content Studio UI: overview, projects, content library, pipeline board, content workspace (script → storyboard → keyframes → clips → voice-overs → render), masters, asset library, costs, operations, settings. The browser talks only to the web origin, which proxies `/api/v1/*` to the API. |
| `apps/api` (NestJS) | Authentication and roles, REST endpoints, validation, domain commands, budget checks, job creation. Persists job intent, then enqueues. No long-running work. |
| `apps/worker` (plain TypeScript) | BullMQ consumers: script/storyboard, image, video (async submit → poll → download), TTS and render jobs; retries, dead-letter, and a reconciler that re-enqueues jobs Redis lost. No HTTP surface (ADR-0013). |
| PostgreSQL | Source of truth for all production state (ADR-0002). |
| Redis + BullMQ | Queue transport only (ADR-0003). |
| S3-compatible storage | Binary files (SeaweedFS locally and on staging; ADR-0006). |

Shared packages:

| Package | Contents |
|---|---|
| `contracts` | Zod request/response schemas and error codes; also generate OpenAPI |
| `database` | Prisma schema, migrations (with SQL triggers/CHECKs), error mapping |
| `content-domain` | Pipeline rules: brief, script and storyboard schemas, content statuses, execution keys, media and render planning, budgets, prompt templates, format/platform registries |
| `ai-core` | Capability interfaces (`LlmProvider`, `ImageProvider`, `VideoProvider`, `TtsProvider`), normalized errors, exact money, routing filters, OpenRouter adapters, mock providers |
| `ai-runtime` | Services shared by API and worker: LLM/image/video/TTS calls with ledger, model catalog, budget reservations, circuit breaker |
| `storage` | Write-once checksummed object store, image validation, content-addressed keys, backup |
| `media` | FFprobe/FFmpeg: media validation, captions, rendering, QC, self-test |
| `config` | Typed environment validation for each app |

## 3. Runtime flow

1. The web app sends a command to the API (for example "generate clips").
2. The API checks the role, the gate, the plan and the budget, then in **one transaction**
   writes the production run, one job per unit of work, and the budget reservation.
3. The API enqueues the jobs (BullMQ id = job id, so a duplicate enqueue does nothing) and
   returns `202` with the job IDs.
4. The worker claims a job, records each state change, re-checks the budget and the provider
   circuit, then calls the provider through its capability interface.
5. Outputs are validated, stored write-once in object storage, and recorded as assets linked to
   their job, scene and inputs. Usage and cost go to the ledger.
6. The web app polls job and run status. A person reviews and approves at each gate.
7. The render job assembles the chosen clips and voice-overs with FFmpeg and runs QC.

Queues: `generation` (script, storyboard), `generation-images`, `generation-video`,
`generation-audio`, `generation-render`.

## 4. Providers and routing

- One interface per capability; a provider declares each capability it supports. Chat support
  does not imply image or video support (ADR-0004).
- Each generation task has one routed model (`ai_task_routes`, set by the operator CLI). A model
  is routable only if enabled and its recorded limits fit the request.
- No automatic fallback to another model. A provider that keeps failing opens its circuit and
  work waits.

Details: `docs/AI_PROVIDER_STRATEGY.md`.

## 5. Storage

- PostgreSQL: metadata, state, prompt snapshots, usage, cost, asset references.
- Object storage: images, clips, audio, subtitles, renders. Keys are
  `projects/{projectId}/assets/{assetId}/{sha256}.{ext}`; objects are never overwritten.
- Redis: queues and short-lived coordination only.
- Browsers never reach storage directly: uploads and downloads go through the API.

## 6. Reliability

- Job intent is persisted before enqueueing; an **execution key** (hash of all inputs) lets
  identical requests reuse earlier results instead of paying again.
- One active job per content item and kind (text, render) or per scene and kind (media).
- Bounded retries: 3 attempts, exponential backoff from 5 s with ±50 % jitter, capped at 5 min,
  respecting `Retry-After`. No retry for invalid input, policy blocks, authentication failures or
  budget blocks.
- Exhausted jobs go to a dead-letter queue and appear on the Operations page with **Resume**.
- Video: the provider job ID is persisted; polling survives worker restarts. A submit whose
  response was lost is never resubmitted automatically (`SUBMIT_OUTCOME_UNKNOWN`).
- Provider circuit breaker: 5 failures in 10 minutes opens it; one trial job closes it again.
- Budgets reserve the estimated cost when jobs are queued (ADR-0019).

## 7. Security

- Server-side sessions in an HttpOnly cookie, Origin check and CSRF token (ADR-0009).
- Roles per project (`owner` > `editor` > `viewer`), checked on every request; non-members get `404`.
- Provider keys live only in server environment variables; never sent to the browser or logged.
  Logs redact credentials and sensitive headers.
- Uploads are checked by magic bytes, size and FFprobe.
- The runtime database role cannot change schema or disable triggers (`docs/DATABASE.md` §8).
- Web pages send a Content-Security-Policy with a per-request script nonce.

## 8. Deployment

| Environment | Topology |
|---|---|
| Local | `pnpm dev` + `pnpm dev:worker`; PostgreSQL, Redis and SeaweedFS in Docker (`infra/compose`) |
| Staging | One Ubuntu VPS, Docker Compose: Caddy (TLS) → web → API, plus worker, PostgreSQL, Redis, SeaweedFS on an internal network (ADR-0014, ADR-0021; `docs/DEPLOYMENT.md`) |

A production setup would add managed PostgreSQL and Redis, central logs and high availability;
it is not built yet.

## 9. Decisions

All architecture decisions are in `docs/adr/` (index: `docs/adr/README.md`).
