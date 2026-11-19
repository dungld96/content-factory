# System Architecture

## 1. Architectural style

Use a **monorepo with modular architecture**. Deploy API and workers as separate processes from the same codebase. Do not split into microservices until measured scaling, isolation, or deployment needs justify it.

## 2. Logical components

### Web app (`apps/web`)
- Content Studio shell (M4.5, `docs/design/M4.5-ui-refinement.md`): overview, projects, content
  library, production pipeline, content workspace, masters, asset library, settings.
- Project and content management UI.
- Script/storyboard editor.
- Asset gallery and approval controls.
- Generation job progress.
- Cost and usage views.
- Final video preview and download.

### API (`apps/api`)
- Authentication and authorization.
- REST endpoints.
- Domain validation.
- Project/content orchestration commands.
- Provider/model registry administration.
- Budget checks.
- Job creation and status queries.

### Worker (`apps/worker`)
Implemented in M3 as a plain TypeScript process (no HTTP surface; ADR-0013): script and
storyboard generation jobs, retries, dead-letter copies and a reconciler for jobs persisted while
Redis was unavailable. The remaining items arrive with M4–M6.
- BullMQ consumers.
- Research/script/storyboard jobs.
- Image/video/TTS generation.
- Provider polling and webhook handling.
- Asset download and validation.
- FFmpeg render jobs.
- Retry and compensation logic.

### Shared packages
- `contracts`: DTOs, Zod schemas, enums.
- `database`: Prisma client and repositories.
- `ai-core`: provider interfaces, model registry, routing, metering.
- `ai-runtime`: LLM service, model catalog and provider wiring shared by the API and the worker
  (M3, design Q1).
- `content-domain`: content, script, storyboard, approval rules; since R0 also the format and
  platform registries, format × platform compatibility and content master/variant rules
  (ADR-0015).
- `storage` (M4a): S3 object store (write-once, checksummed), image validation, content-addressed
  keys, bucket setup. `media` (FFmpeg/FFprobe) arrives with video and render (M5–M6).
- `config`: typed environment configuration.

## 3. Runtime flow

1. Web calls API to create a content item.
2. API persists the item and initial production run.
3. API enqueues a job and returns a run ID.
4. Worker claims the job and records state transitions.
5. Worker calls the appropriate capability adapter.
6. Provider result is normalized.
7. Output is downloaded and stored in object storage.
8. Database records asset and generation lineage.
9. Worker enqueues the next stage only when prerequisites and approvals are satisfied.
10. Web polls or subscribes to run updates.
11. User reviews outputs and approves/rejects.
12. Render worker assembles approved assets.

## 4. Orchestration boundaries

- NestJS owns domain state and permissions.
- PostgreSQL is the source of truth for production state.
- BullMQ/Redis transports asynchronous work; it is not the source of truth.
- n8n is optional for external integrations, scheduled research, notifications, and operator workflows. Do not store the only copy of a production state machine in n8n.
- Workers must be idempotent and safe to retry.

## 5. Provider architecture

Separate capability interfaces:

- `LlmProvider`
- `ImageProvider`
- `VideoProvider`
- `TtsProvider`
- Optional later: `TranscriptionProvider`, `MusicProvider`, `VisionEvaluationProvider`

A provider may implement more than one capability, but it must register each capability explicitly. Do not assume OpenAI-compatible chat support implies image/video support.

## 6. Routing

Routing inputs:
- Capability.
- Requested quality tier.
- Required features (reference image, image edit, duration, aspect ratio, audio, etc.).
- Project allowlist/denylist.
- Budget remaining.
- Provider/model availability.
- Estimated latency.
- Data policy constraints.

Routing output:
- Provider ID.
- Model ID.
- Capability configuration.
- Estimated cost or unknown.
- Explanation/routing reason.

Fallback is permitted only when the alternative supports the same required capability and constraints. Do not silently downgrade quality or remove required features.

## 7. Storage

- PostgreSQL stores metadata, state, prompts, usage, and asset references.
- Object storage stores generated images, clips, audio, subtitles, and exports.
- Redis stores queue/cache/short-lived coordination data.
- Do not store large binary media in PostgreSQL.

Use private object storage by default. Generate short-lived signed URLs for downloads/previews.

## 8. Reliability patterns

- Idempotency key for generation requests.
- Unique stage execution key per content version + scene + stage + attempt policy.
- Exponential backoff with jitter for transient errors.
- No automatic retry for invalid input, policy rejection, or insufficient funds.
- Provider polling with bounded attempts and deadline.
- Dead-letter queue for exhausted jobs.
- Persist provider job IDs.
- Persist every state transition.
- Reconcile orphaned provider jobs after worker restart.
- Use an outbox pattern if database commit and queue enqueue must be made atomic.

## 9. Security

- Secrets only in server environment/secret store.
- Never return provider credentials to frontend.
- Redact authorization headers and sensitive prompt data from logs where required.
- Validate all uploaded files and limit size/type.
- Restrict object storage access.
- Apply per-user/project authorization.
- Add rate limits to expensive endpoints.
- Record admin changes to provider configuration and budgets.

## 10. Suggested deployment topology

Local development:
- `web`
- `api`
- `worker`
- `postgres`
- `redis`
- `minio` (optional local S3-compatible storage)
- `n8n` (optional)
- `langfuse` (optional; can be deferred)

Staging (implemented, ADR-0014): one Google Cloud VM with Docker Compose — Caddy (TLS) →
web → API, plus worker, PostgreSQL and Redis on an internal network. See `docs/DEPLOYMENT.md`.

Production pilot:
- Web/API/worker containers.
- Managed PostgreSQL.
- Managed Redis.
- S3-compatible storage.
- Reverse proxy/TLS.
- Centralized logs and backups.

## 11. Architecture decision records

Create `docs/adr/` and record material decisions. Initial ADRs:
- ADR-001: Monorepo modular architecture.
- ADR-002: PostgreSQL as source of truth.
- ADR-003: BullMQ for background execution.
- ADR-004: Capability-specific provider adapters.
- ADR-005: Human approval gates.
- ADR-006: S3-compatible object storage.
