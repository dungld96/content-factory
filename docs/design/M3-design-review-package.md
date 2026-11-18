# M3 Design Review Package — Script and Storyboard Pipeline

- Status: **Revision 1, approved by the owner (2026-11-18).** Implemented in slices M3a–M3e (§13).
- Date: 2026-11-18
- Baseline: M2 accepted (`80060cc`)
- Companion: ADR-0013 (accepted) — generation jobs, queue and worker process

## 0. Decision log

Owner decisions taken before this package (2026-11-18):

| ID  | Decision                                                                                                        | Status   |
| --- | --------------------------------------------------------------------------------------------------------------- | -------- |
| F1  | Generation runs as **async jobs**: intent in PostgreSQL, BullMQ transport, separate **`apps/worker`** process   | Approved |
| F2  | **No research provider** in M3. Users attach source URLs/facts to the brief; scripts cite only those            | Approved |
| F3  | The **content plan** (angle, hooks, key message, CTA) is part of the script output, reviewed at the script gate | Approved |
| F4  | **Minimal working web UI** for scripts and storyboards, with Playwright E2E on a mocked LLM                     | Approved |

Decisions in this package (§12), **all approved by the owner as proposed (2026-11-18)**:

| ID  | Proposal                                                                                                                              | Section |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Q1  | Extract M2's `LlmService`/registry read side into `packages/ai-runtime` (plain classes) so API and worker share it                    | §3      |
| Q2  | Every edit creates a new **immutable version**; there are no editable drafts for scripts/storyboards                                  | §6      |
| Q3  | Approval moves a content-item **pointer** (`approved_script_version_id`, `approved_storyboard_version_id`); approvals are append-only | §6.3    |
| Q4  | Model per task from a registry table `ai_task_routes` (operator CLI), overridable per request by an editor                            | §7.2    |
| Q5  | Invalid model output: deterministic repair, then **one** LLM repair call, then the job fails (`OUTPUT_INVALID`)                       | §7.4    |
| Q6  | Scene durations must sum to the target within **max(1 s, 5 %)**                                                                       | §5.3    |
| Q7  | Minimal production runs: one run per generate request; cancel for queued jobs; resume deferred to M5/M7                               | §8      |
| Q8  | Dead-letter queue `generation-dlq` after retry exhaustion; DB stays the source of truth                                               | §8.4    |

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M3):** brief validation; script generation (with the content plan);
JSON-schema validation and safe repair/rejection of model output; storyboard generation; versioning
and approval endpoints and UI; the job/queue/worker foundation they need.

**Out of scope:** research providers (F2); image/video/TTS (M4/M5); budgets and circuit breakers
(M7; M3 only records cost per job); production-run resume across stages (M5/M7); streaming.

**Acceptance (IMPLEMENTATION_PLAN §M3) and evidence:**

| Criterion                                        | Evidence                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| A brief produces valid script/storyboard JSON    | Worker integration test (real PostgreSQL + Redis, mock LLM) and Playwright E2E: brief → script → storyboard          |
| Invalid model output is repaired/rejected safely | Unit tests of the parser/repair ladder; worker tests: repaired, rejected (`OUTPUT_INVALID`), never persisted invalid |
| User edits create a new version                  | API tests: PATCH script/scene → new version, original unchanged; DB trigger refuses changing a version (`AC012`)     |

## 2. Verification of the new dependency (BullMQ)

Checked from the npm registry and the published package on 2026-11-18 (official docs host
`docs.bullmq.io` is not reachable from this session; the package's own type definitions were read):

- `bullmq@6.7.7` (published 2026-11-17; 6.7.x line since 2026-11-07), MIT, `engines.node >=14.18`.
- Peer dependencies `ioredis >=5`, `redis >=5`, `pg >=8`, `bullmq-otel >=2`, **all optional**. The
  repository already pins `ioredis@6.0.0`; queues/workers receive an `ioredis` connection.
- `BackoffOptions { type: 'fixed' | 'exponential', delay, jitter }` → exponential backoff **with jitter**
  (CLAUDE.md §7); `UnrecoverableError` stops retries; workers have stalled-job detection
  (`stalledInterval`, `maxStalledCount`, `lockDuration`) for worker restarts.
- Redis already runs with `noeviction` and AOF (ADR-0003).
- Implementation slice M3c starts with a compatibility test against the local Redis 7.4.12; if
  6.7.7 misbehaves, the fallback is the latest 6.x with a test pass, recorded in ADR-0013.

## 3. Packages and processes (Q1)

```text
packages/content-domain/   NEW  pure TypeScript, no Nest, no Prisma:
  brief.ts                       brief normalization + validation rules (§5.1)
  script.ts, storyboard.ts       zod schemas (+ JSON Schema export) for model output and edits
  prompts/                       versioned prompt templates (§7.3)
  output.ts                      parse → repair ladder (§7.4)
  pipeline.ts                    content status transitions (§9)
packages/ai-runtime/       NEW  M2's LlmService + RegistryService read side + provider factory +
                                money helpers, moved from apps/api/src/ai as plain classes
                                (constructor-injected PrismaClient, provider map, options)
apps/api                        Nest wrappers for ai-runtime; HTTP for briefs, jobs, scripts,
                                storyboards, runs; enqueues jobs
apps/worker/               NEW  Nest application context (no HTTP): BullMQ consumers, outbox
                                reconciler, processors for script/storyboard generation
```

- The move is mechanical: same behaviour and tests; the API's `AiModule` becomes a thin Nest
  wrapper. The ESLint rule that confines `@acf/ai-core/openrouter` moves with the factory to
  `packages/ai-runtime/src/providers/**`.
- Shared persistence helpers for versions (create/approve) live in `apps/api` and `apps/worker`
  only through `packages/content-domain` rules plus Prisma calls in each app (no repository
  package yet; ARCHITECTURE lists repositories under `database`, kept for a later need).
- New dependency: `bullmq@6.7.7` in `apps/api` (enqueue) and `apps/worker` (consume). Nothing else.

## 4. Database (migration `m3_script_storyboard`)

### 4.1 Jobs and runs

```prisma
enum GenerationJobKind   { script_generation storyboard_generation }
enum GenerationJobStatus { queued running succeeded failed canceled }   // DATABASE.md JobStatus subset
enum ProductionRunStatus { queued running succeeded failed canceled }

model ProductionRun {        // Q7: one per generate request in M3
  id, projectId, contentItemId (composite FK), status, requestedById, createdAt, updatedAt
}

model GenerationJob {
  id, projectId, contentItemId (composite FK), productionRunId (composite FK)
  kind               GenerationJobKind
  status             GenerationJobStatus @default(queued)
  idempotencyKey     String  @unique         // client key, or derived from the execution key
  executionKey       String                  // sha256 of the inputs (§7.5)
  input              Json                    // ids + parameters; no secrets
  promptTemplateId   String                  // e.g. "script.v1"
  promptSnapshot     String?  @db.Text       // fully resolved prompt (CONTENT_PIPELINE §4)
  modelId            String?                 // ai_models row used
  attempt            Int     @default(0)
  maxAttempts        Int     @default(3)
  resultScriptVersionId / resultStoryboardVersionId  (nullable, composite FKs)
  errorCode, errorMessage (sanitized)
  requestedById, queuedAt, startedAt, completedAt, updatedAt
}

model JobEvent {             // append-only state transitions (CLAUDE.md §7)
  id, jobId (composite FK), fromStatus, toStatus, attempt, detail Json, createdAt
}
```

- `ai_invocations.generation_job_id` gets its foreign key now (M2 decision E4); invocation
  idempotency key = `"{jobId}:{attempt}:{call}"`.
- Partial unique index: at most one **active** (`queued`/`running`) job per (content item, kind).

### 4.2 Scripts and storyboards (Q2, Q3)

```prisma
enum ArtifactStatus { pending_review approved rejected }
enum ArtifactSource { generated edited }

model ScriptVersion {
  id, projectId, contentItemId (composite FK)
  version            Int                     // 1, 2, … per content item
  status             ArtifactStatus @default(pending_review)
  source             ArtifactSource
  basedOnVersionId   String?                 // same content item (composite FK)
  generationJobId    String?                 // set for generated versions
  schemaVersion      Int                     // ScriptContent schema version (1)
  content            Json                    // validated ScriptContent (§5.2)
  createdById        String?                 // editor for edited versions; null for generated
  reviewedById, reviewedAt, reviewNote       // set exactly once, on approve/reject
  createdAt
  @@unique([contentItemId, version])
}

model StoryboardVersion {
  id, projectId, contentItemId, version, status, source, basedOnVersionId, generationJobId
  scriptVersionId    String                  // the APPROVED script it was generated from
  schemaVersion, totalDurationSeconds, createdById, reviewedById, reviewedAt, reviewNote, createdAt
  scenes             StoryboardScene[]
}

model StoryboardScene {      // immutable with its version
  id, projectId, storyboardVersionId (composite FK)
  sceneNumber        Int                     // 1..n, contiguous
  durationSeconds    Decimal @db.Decimal(6,2)
  shotType, cameraAngle, cameraMovement, characterAction, visualDescription,
  imagePrompt, videoPrompt, negativePrompt, voiceOverSegment, onScreenText  (text)
  characterVersionId   String?   // composite FK, project-scoped
  environmentVersionId String?   // composite FK, project-scoped
  acceptanceChecks     String[]
  referenceAssets      StoryboardSceneAsset[]   // (scene, asset) pairs, project-scoped
  @@unique([storyboardVersionId, sceneNumber])
}

// content_items gains:
//   approved_script_version_id      (composite FK → script_versions of the same item)
//   approved_storyboard_version_id  (composite FK → storyboard_versions of the same item)
```

### 4.3 Integrity (ADR-0011 style)

| Rule                                                                                                                                                        | Mechanism              | SQLSTATE                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| Versions, scenes and scene assets are immutable after insert, except the one-time review (`pending_review` → `approved`/`rejected`, with reviewer and time) | trigger                | `AC012`                       |
| A content item's approved pointer references an **approved** version of **that** item; the storyboard pointer's script is the item's approved script        | composite FK + trigger | `AC013`                       |
| Approving a storyboard requires its `script_version_id` = the item's approved script                                                                        | trigger                | `AC013`                       |
| Job events, runs' and jobs' identity columns are append-only / immutable                                                                                    | trigger                | `AC011` (reused: ledger rule) |
| Scene durations > 0, scene numbers ≥ 1; versions ≥ 1; `attempt ≤ max_attempts`                                                                              | CHECK                  | `23514`                       |

**Locking:** approval locks the **version** row, then the **content item** (parent) — the
existing global order _Version → Parent_ (ADR-0011 §6). Edits insert a new version under a
`FOR NO KEY UPDATE` lock on the content item (allocates the next `version`), the same order as
characters. M3b extends the deterministic lock matrix with: double approval, approve vs edit,
approve script vs approve storyboard, approve vs archive content item; acceptance stays **0 × `40P01`**.

## 5. Domain contracts (`packages/content-domain`)

### 5.1 Brief validation (stage 1, deterministic, no LLM)

`validateBrief(content item)` → `{ normalized, errors[], warnings[], flags[] }`:

- **errors** (block generation; content → `needs_input`): missing topic; target duration outside
  5–180 s for `short_video`; character/environment reference without an approved master.
- **warnings**: no audience, objective, tone or CTA; no source URLs while the topic reads as a
  product/price/statistic claim (keyword heuristics); duration not a multiple the pilot expects.
- **flags**: commercial-claim terms (price, "best", discount, medical/financial words) → the
  script prompt asks for `claimsRequiringVerification`.
- The brief gains optional `characterId` and `environmentId` (same project); generation uses
  their **approved master versions** at that time and records the version IDs.

Exposed as `POST /content/:contentId/brief/validate` (cheap, synchronous) and re-run by every
generate request.

### 5.2 Script output (`ScriptContent`, schema version 1)

```typescript
{
  title: string;                       // ≤ 120
  plan: {                              // F3: content plan inside the script
    angle: string; audienceInsight: string; hookOptions: string[];   // 1–3
    keyMessage: string; callToAction: string; estimatedSceneCount: number;  // 1–12
  };
  hook: string;
  voiceOver: string;                   // full narration
  onScreenText: string[];
  sceneOutline: { order: number; summary: string; approxSeconds: number }[];  // 1–12
  callToAction: string;
  claimsRequiringVerification: { claim: string; reason: string }[];
  sources: { url: string; usedFor: string }[];   // ⊆ brief.sourceUrls (§7.4)
}
```

### 5.3 Storyboard output (`StoryboardContent`, schema version 1)

Scenes with exactly the fields of CONTENT_PIPELINE stage 5. Rules after schema validation:
scene numbers 1..n contiguous; Σ duration within **max(1 s, 5 % of target)** (Q6); referenced
character/environment versions are the approved masters given in the prompt; reference asset IDs
⊆ the assets attached to those versions. The model never invents IDs: the prompt lists the
allowed IDs and the validator rejects others.

Both schemas are zod; the JSON Schema sent as `response_format` is generated from them
(`z.toJSONSchema`), so validator and request schema cannot diverge.

## 6. Versioning and approval

### 6.1 Versions are immutable (Q2)

- Generated output → version N (`source: generated`, `pending_review`).
- `PATCH /scripts/:id` with a full or partial `ScriptContent` → **new** version N+1 (`edited`,
  `basedOnVersionId`), validated by the same schema; the original is untouched (DB `AC012`).
- `PATCH /scenes/:sceneId` → new storyboard version with that scene changed and the other scenes
  copied; durations re-validated (Q6).
- Concurrent edits of the same base: both succeed as separate versions (no lost update); the UI
  shows the newest. `If-Match` (D9) applies to the base version.

### 6.2 Review

- `approve` / `reject` (editor+; viewers never) set the review fields once. Rejected versions stay
  for history. Approving version N while N−1 is approved is allowed: the pointer moves to N.

### 6.3 Pointers and staleness (Q3, ADR-0005)

- `content_items.approved_script_version_id` moves on script approval; storyboards generated from
  an older script become **stale** (computed: `storyboard.script_version_id ≠ approved script`),
  are shown as stale, and cannot be approved (`AC013`). Nothing is deleted.
- Storyboard generation requires an approved script (gate 1). Approving a storyboard sets
  `approved_storyboard_version_id` (gate 2, before any paid media in M4).

## 7. Generation

### 7.1 Flow (ADR-0003)

1. API validates the request and brief, resolves inputs (approved script, masters, model route),
   computes the **execution key** (§7.5).
2. Reuse: if a succeeded job with the same execution key exists and `regenerate` is not set, return
   it (no new cost; CLAUDE.md §2.9).
3. In one transaction: insert `production_runs` + `generation_jobs` (`queued`) + `job_events`;
   content status transition (§9).
4. After commit: `queue.add('generate', { jobId }, { jobId })` — BullMQ `jobId` = DB id, so a
   duplicate add is a no-op. If Redis is down, the job stays `queued` in PostgreSQL and the
   worker's **reconciler** (§8.3) enqueues it later (outbox equivalent).
5. Response `202 { productionRunId, job }`.

### 7.2 Model choice (Q4)

`ai_task_routes(task, model_id, updated_by, updated_at)`, one row per task
(`script_generation`, `storyboard_generation`), set with `pnpm ai:registry route set <task>
<modelKey>`. An editor may pass `modelKey` on a generate request; routing (M2) still requires the
model to be enabled, configured and parameter-capable (`response_format` + `structured_outputs`).
No route and no override → `422 NO_MODEL_ROUTE`. The dev seed routes both tasks to `mock/echo`.

### 7.3 Prompts

Versioned templates in code (`script.v1`, `storyboard.v1`, `repair.v1`), each with a zod schema
for its variables; rendering fails on missing/extra variables. The resolved prompt is stored on
the job (`prompt_snapshot`); the template id+version is part of the execution key. User text is
inserted as delimited data, with the instruction to treat it as content, not instructions.

### 7.4 Output handling (Q5)

1. Parse: the model returns JSON under `response_format` (strict). Deterministic repair only:
   strip a code fence or text around one top-level JSON object.
2. Validate with the zod schema and the domain rules (§5.2–5.3).
3. If invalid: **one** repair call (`repair.v1`: the schema, the validation errors, the invalid
   JSON) on the same model; then validate again.
4. Still invalid → job `failed`, `OUTPUT_INVALID` (not retried: the same inputs would likely fail
   the same way; the user can regenerate). Invalid output is **never** persisted as a version;
   only the validation error paths (no content) are stored on the job event.
5. Script `sources` not in `brief.sourceUrls` are a validation error (anti-fabrication, F2).

### 7.5 Idempotency and execution key

`executionKey = sha256(kind, content item id, brief hash, input version IDs (approved script,
character/environment masters, reference assets), template id+version, model id, prices not
included)`. Client `idempotencyKey` (header `Idempotency-Key`, optional) dedupes retries of the
same HTTP request; the execution key dedupes identical work (§7.1 step 2).

## 8. Worker (`apps/worker`)

### 8.1 Processing

- Consumer of queue `generation` (concurrency configurable, default 2). For each delivery:
  load the job; if not `queued`/`running` (canceled, done) → ack and stop. Transition to
  `running`, `attempt += 1`, event. Build the prompt, call `LlmService` (M2), handle output (§7.4),
  then in one transaction: insert the version (+ scenes), mark the job `succeeded`, link the result,
  event, content status transition.
- Every LLM call records an `ai_invocations` row linked to the job (cost per job, M2 ledger).

### 8.2 Retries

- BullMQ `attempts: 3`, `backoff: { type: 'exponential', delay: 5000, jitter: 0.5 }`.
- `ProviderError.retryable === false`, `RoutingError`, `OUTPUT_INVALID` → `UnrecoverableError`:
  no retry (CLAUDE.md §7: invalid requests, policy, auth, budget blocks are never retried).
- `RATE_LIMITED` with `retryAfterMs` → the next delay is at least that value.
- A retried attempt after `outcome_unknown` (timeout) may double-charge; the cost is recorded per
  attempt, never hidden.

### 8.3 Restarts and reconciliation

- Stalled jobs (worker died mid-attempt) are redelivered by BullMQ; the DB row is `running` with
  an older attempt → treated as a new attempt (event `stalled_recovered`).
- Reconciler (at start and every 60 s): DB jobs `queued` older than 30 s and not in Redis →
  enqueue (idempotent `jobId`); `running` jobs whose BullMQ job no longer exists past the lock
  duration → back to `queued` once, else `failed` (`WORKER_LOST`). Abandoned invocations
  (`markAbandoned`, M2) are swept at worker start — the worker, not the API, owns this.

### 8.4 Dead letter (Q8)

After the final failed attempt the job is `failed` in PostgreSQL (authoritative), and a copy
`{ jobId, errorCode }` is added to queue `generation-dlq` for operators; nothing consumes it
automatically in M3 (M7 adds tooling).

### 8.5 Cancel (Q7)

`POST /production-runs/:runId/cancel`: queued jobs → `canceled` (worker skips them); a running
job finishes its current LLM call and is then discarded (`canceled`, its version is not
persisted, its cost is recorded).

## 9. Content status (state machine, `content-domain/pipeline.ts`)

| From                                    | Event                                  | To                                                                           |
| --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `draft`, `needs_input`, `script_review` | script job queued                      | `scripting`                                                                  |
| any                                     | brief validation errors on generate    | `needs_input`                                                                |
| `scripting`                             | script version created                 | `script_review`                                                              |
| `scripting`                             | job failed/canceled                    | previous status                                                              |
| `script_review`                         | script approved, storyboard job queued | `storyboarding`                                                              |
| `storyboarding`                         | storyboard version created             | `storyboard_review`                                                          |
| `storyboarding`                         | job failed/canceled                    | `script_review`                                                              |
| `storyboard_review`                     | storyboard approved                    | `storyboard_review` (gate 2 satisfied; `generating_assets` is entered by M4) |

The previous status is stored on the job input so failure restores it exactly. Transitions are
unit-tested as a table and enforced in the service transaction.

## 10. API (base `/api/v1`)

| Endpoint                                              | Viewer | Editor/Owner | Notes                                                        |
| ----------------------------------------------------- | :----: | :----------: | ------------------------------------------------------------ |
| `POST /content/:contentId/brief/validate`             |   ✓    |      ✓       | Sync, no LLM                                                 |
| `POST /content/:contentId/scripts/generate`           |  403   |     202      | Body `{ modelKey?, regenerate? }`; header `Idempotency-Key?` |
| `GET /content/:contentId/scripts`                     |   ✓    |      ✓       | Paginated, newest first                                      |
| `GET /scripts/:scriptVersionId`                       |   ✓    |      ✓       |                                                              |
| `PATCH /scripts/:scriptVersionId`                     |  403   |     201      | New version; `If-Match`                                      |
| `POST /scripts/:scriptVersionId/approve`              |  403   |      ✓       |                                                              |
| `POST /scripts/:scriptVersionId/reject`               |  403   |      ✓       | Body `{ note? }`                                             |
| `POST /scripts/:scriptVersionId/storyboards/generate` |  403   |     202      | Script must be the approved one                              |
| `GET /content/:contentId/storyboards`                 |   ✓    |      ✓       | Includes `stale`                                             |
| `GET /storyboards/:storyboardVersionId`               |   ✓    |      ✓       | With scenes                                                  |
| `PATCH /scenes/:sceneId`                              |  403   |     201      | New storyboard version                                       |
| `POST /storyboards/:storyboardVersionId/approve`      |  403   |      ✓       |                                                              |
| `POST /storyboards/:storyboardVersionId/reject`       |  403   |      ✓       |                                                              |
| `GET /production-runs/:runId`                         |   ✓    |      ✓       | Status, jobs, cost summary (reported/estimated/unknown)      |
| `POST /production-runs/:runId/cancel`                 |  403   |      ✓       |                                                              |
| `GET /generation-jobs/:jobId`                         |   ✓    |      ✓       | Status, attempts, events, error (sanitized), cost            |

Non-members 404, unauthenticated 401 (M1 rules); all rows join the permission matrix. New error
codes: `NO_MODEL_ROUTE` (422), `BRIEF_INVALID` (422, with details), `SCRIPT_NOT_APPROVED` (409),
`STALE_STORYBOARD` (409), `VERSION_IMMUTABLE` reused for `AC012`, `GENERATION_IN_PROGRESS` (409,
one active job per item and kind).

## 11. Web UI (F4) and testing

**UI** (Next.js, same-origin proxy): project page lists content items; content page shows the brief
with validation warnings, "Generate script", job progress (polling `GET /generation-jobs/:id`
every 2 s), script versions (view, edit form → new version, approve/reject), then "Generate
storyboard", scene table (edit a scene → new version), approve; stale storyboards marked. Viewers
see no generate/edit/approve controls (and the API refuses them anyway).

**Tests:**

| Layer                   | What                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (`content-domain`) | brief rules; schemas; repair ladder; duration tolerance; ID allow-lists; source ⊆ brief; status transition table; prompt variable validation                                                                                                                 |
| Unit (`ai-runtime`)     | M2 tests moved unchanged                                                                                                                                                                                                                                     |
| DB integration          | migration, CHECKs, `AC011`–`AC013`, composite FKs, presence/drift; lock matrix extended (§4.3), 0 × `40P01`                                                                                                                                                  |
| Worker integration      | real PostgreSQL + Redis, mock LLM: success; repaired output; `OUTPUT_INVALID`; retryable error → retry with backoff; non-retryable → no retry; DLQ copy; stalled worker; reconciler (Redis down at enqueue); cancel; execution-key reuse; cost linked to job |
| API integration         | every endpoint; permission matrix; immutability of versions; staleness; gates (no storyboard without approved script)                                                                                                                                        |
| E2E (Playwright)        | login → content → generate script (worker with a fixture LLM) → edit → approve → generate storyboard → edit scene → approve                                                                                                                                  |
| Paid smoke              | not needed: M2's smoke covers the provider; M3 adds no provider                                                                                                                                                                                              |

The worker's E2E entry point injects a **fixture LLM** that returns schema-valid JSON; it lives
under `apps/worker/test/` and is never part of the production build.

## 12. Decisions requested, and risks

| ID  | Recommendation (as proposed above)                 | Alternative                                                                                         |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Q1  | Extract `packages/ai-runtime` (mechanical move)    | `apps/worker` imports from `apps/api` (cross-app import), or worker as a second entry in `apps/api` |
| Q2  | Immutable versions; every edit = new version       | Editable drafts until review (as characters, D11)                                                   |
| Q3  | Approval pointers on the content item              | "Latest approved version wins", computed                                                            |
| Q4  | `ai_task_routes` + optional per-request `modelKey` | Env variables per task (deploy to change)                                                           |
| Q5  | One LLM repair call, then `OUTPUT_INVALID`         | No repair call (fail immediately) / up to 2                                                         |
| Q6  | Tolerance max(1 s, 5 %)                            | Configurable per project                                                                            |
| Q7  | Minimal runs; cancel; resume later                 | Full multi-stage runs now                                                                           |
| Q8  | `generation-dlq` copy; DB authoritative            | BullMQ failed set only until M7                                                                     |

| ID  | Risk                                                                                               | Mitigation                                                                                  |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S1  | All real models are disabled and unbenchmarked; M3 runs on `mock/echo` until the owner enables one | Routes are data; the owner enables a model after the M2 smoke test                          |
| S2  | Strict structured output varies by provider (M2 verification §1)                                   | Schema validation + repair ladder; `require_parameters: true`                               |
| S3  | Prompt injection through brief text                                                                | Delimited data, schema-constrained output, ID allow-lists; the model cannot trigger actions |
| S4  | Retried attempts after timeouts can double-charge                                                  | Cost per attempt recorded; max 3 attempts; budgets in M7                                    |
| S5  | BullMQ verified from package metadata and types only (docs host unreachable)                       | M3c starts with a compatibility test on real Redis                                          |
| S6  | Refactor Q1 touches approved M2 code                                                               | Mechanical move; M2 tests must pass unchanged                                               |

## 12.1 Implementation notes (deviations decided during M3a–M3c)

- `apps/worker` is plain TypeScript with explicit constructor wiring (no Nest application
  context): it has no HTTP surface, and the shared runtime is already plain classes (Q1).
- BullMQ 6.7.7 verified on Redis 7.4.12 (`apps/worker/test/queue.integration.test.ts`): enqueue,
  idempotent duplicate adds, retries through a custom backoff strategy that honours the processor's
  delay (`Retry-After`), dead-letter copies, reconciliation. BullMQ rejects custom job ids that
  contain `:` (dead-letter ids use `-`); `attemptsMade` counts every started attempt, like
  `generation_jobs.attempt`.
- A failed dead-letter write is logged and never undoes the recorded failure (PostgreSQL is
  authoritative).
- `generation_jobs.active_key` (unique, set while queued/running) implements "one active job per
  item and kind" without a partial index, which Prisma cannot model (drift check).
- The worker, not the API, sweeps abandoned LLM invocations at start-up.
- pnpm keeps the optional `msgpackr-extract` build script (a BullMQ transitive dependency)
  blocked; msgpackr falls back to its JavaScript implementation.

## 13. Implementation plan (each slice tested before the next)

| Slice | Scope                                                                                                                                        | Status      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| M3a   | `packages/content-domain` (brief, schemas, prompts, repair ladder, pipeline); `packages/ai-runtime` extraction (Q1) with M2 tests green      | Done        |
| M3b   | Migration `m3_script_storyboard`; integrity triggers/CHECKs; DB tests; lock-matrix extension; ai_invocations job FK                          | Done        |
| M3c   | BullMQ + `apps/worker`: queue, processors, retries/backoff/jitter, DLQ, reconciler, cancel, restarts; worker integration tests on real Redis | Done        |
| M3d   | API endpoints, contracts, OpenAPI, permission matrix, error codes; `ai_task_routes` CLI; seed routes                                         | Not started |
| M3e   | Web UI, Playwright E2E with the fixture LLM; docs (API_SPEC, DATABASE, CONTENT_PIPELINE, ARCHITECTURE, LOCAL_DEVELOPMENT, ADR-0013)          | Not started |
