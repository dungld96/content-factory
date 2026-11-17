# M2 Design Review Package — AI Core and Model Registry

- Status: **Revision 1, approved by the owner (2026-11-17).** Implemented in slices M2a–M2d (§12).
- Date: 2026-11-17
- Baseline: M1 approved (branch `claude/gracious-planck-kuf4pq`, `58cb986`)
- Companion files:
  - [`m2/openrouter-verification.md`](m2/openrouter-verification.md): every OpenRouter fact this
    design relies on, with source page and retrieval date
  - ADR-0012 (accepted): money precision, registry and usage ledger

## 0. Decision log

Owner decisions taken before this package (2026-11-17):

| ID  | Decision                                                                                       | Status   |
| --- | ---------------------------------------------------------------------------------------------- | -------- |
| E1  | The single real LLM adapter targets **OpenRouter** (text only; AI_PROVIDER_STRATEGY §6)        | Approved |
| E2  | Design package first, reviewed before any code (as in M1)                                      | Approved |
| E3  | Registry edited by **CLI**; the API exposes it **read-only**. No new authorization model in M2 | Approved |
| E4  | Usage persists with project/content context and a **nullable** job link (jobs arrive in M5)    | Approved |

Decisions in this package (§11), **all approved by the owner as proposed (2026-11-17)**, including S1:

| ID  | Proposal                                                                                                   | Section |
| --- | ---------------------------------------------------------------------------------------------------------- | ------- |
| P1  | Money as exact decimal USD (`NUMERIC(38,18)`), not integer micros                                          | §5      |
| P2  | One `ai_invocations` row per provider call, plus per-metric `usage_records` rows                           | §6.3    |
| P3  | Prices and usage records are append-only (new SQLSTATE `AC011`)                                            | §6.4    |
| P4  | Adapters never retry; they return a normalized error with `retryable` / `fallbackAllowed`                  | §4.3    |
| P5  | OpenRouter requests default to `data_collection: "deny"` and `require_parameters: true`; no model fallback | §7.2    |
| P6  | Vendor code is reachable only through a lint-enforced subpath import                                       | §3.1    |
| P7  | M2 exposes no endpoint that calls a model; the only real call path is a manual, budget-capped smoke CLI    | §8      |

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M2):**

- capability interfaces (`LlmProvider` implemented; image, video, TTS declared as types only);
- provider registry and model registry, persisted in PostgreSQL and edited by CLI;
- one LLM adapter (OpenRouter, non-streaming chat completions);
- usage/cost normalization (reported vs estimated vs unknown cost);
- provider configuration validation (server-only credentials);
- a deterministic mock provider for automated tests;
- read-only registry API; a manual paid smoke test, off by default and budget-capped.

**Out of scope (later milestones):** BullMQ jobs and `GenerationJob` / `ProductionRun` (M5),
budgets and their enforcement, retry/backoff, circuit breaker, dead-letter queue (M7), streaming,
tool calling, image/video/TTS adapters (M4/M5), cost dashboards and usage endpoints (M7), web UI,
BYOK, project-level provider allow/deny lists.

**Acceptance (IMPLEMENTATION_PLAN §M2) and how it is shown:**

| Criterion                                       | Evidence                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Business logic uses interfaces, not vendor SDKs | No vendor SDK dependency at all (`fetch` only); ESLint forbids `@acf/ai-core/openrouter` outside one API module (§3.1)           |
| Mock tests do not make paid calls               | Adapter contract tests run against a local HTTP fixture server; CI has no key; a test fails if `openrouter.ai` is contacted (§9) |
| Provider errors are normalized                  | Table-driven contract tests cover every documented status and `error_type` (§4.3)                                                |

## 2. Findings from verification

Verified against official OpenRouter documentation on 2026-11-17
([record](m2/openrouter-verification.md)). Four findings change the design:

1. **Integer micros cannot hold LLM costs.** Prices are USD per token with up to 22 decimal places
   (`0.0000000416666666666667`), and a short call can cost less than one micro-dollar
   (10 tokens × USD 0.023/M = USD 0.00000023). Rounding every call to micros would record many
   calls as 0, which violates "unknown cost is not zero cost" in spirit and loses real spend. → P1.
2. **Prices are tiered and multi-part.** Input, output, cache read, cache write, reasoning, per-request,
   and prompt-size overrides (`min_prompt_tokens`). A price is a set of rows, not two columns. → §6.2.
3. **Failure after acceptance returns HTTP 200.** A non-streaming call can return `200` with an
   `error` object, `finish_reason: "error"`, or an empty `length` completion that is still charged.
   Status codes alone cannot classify outcomes. → §4.3, §7.3.
4. **OpenRouter reports cost per call** (`usage.cost`, USD, nullable) but not per metric. Reported and
   estimated costs therefore live at different granularities. → P2.

## 3. Package and module structure

### 3.1 `packages/ai-core` (new workspace package, ADR-0001/0004)

```text
packages/ai-core/src/
  index.ts                 # public, vendor-free API (re-exports below)
  capability.ts            # Capability enum, QualityTier
  llm.ts                   # LlmProvider, LlmRequest, LlmResult
  media.ts                 # ImageProvider, VideoProvider, TtsProvider: types only (M4/M5)
  errors.ts                # ProviderError, ProviderErrorCode, policy table
  money.ts                 # UsdAmount: exact decimal arithmetic (BigInt, scale 18)
  pricing.ts               # PriceComponent, cost estimation from usage + price rows
  usage.ts                 # NormalizedUsage, CostAssessment (reported / estimated / unknown)
  routing.ts               # candidate filtering + explanation (no scoring in M2)
  testing/mock-llm.ts      # MockLlmProvider (scripted outcomes); exported as @acf/ai-core/testing
  openrouter/              # adapter; exported only as @acf/ai-core/openrouter
```

- Package `exports`: `.`, `./testing`, `./openrouter`.
- An ESLint `no-restricted-imports` rule forbids `@acf/ai-core/openrouter` everywhere except
  `apps/api/src/ai/providers/**` (the DI wiring), and `@acf/ai-core/testing` outside tests.
  Business code can only see `LlmProvider`.
- Dependencies: `zod` (already pinned in the workspace, 4.6.7). **No new third-party dependency**:
  HTTP uses Node's built-in `fetch`; decimal math uses `BigInt`. The official OpenRouter SDK exists
  but is not needed for one endpoint and would put a vendor SDK on the dependency graph.

### 3.2 API module `apps/api/src/ai/`

- `providers/`: builds the provider instances from validated config and registers them by
  capability (Nest DI tokens per capability, e.g. `LLM_PROVIDERS`).
- `registry/`: `RegistryService` (reads providers, models, active prices), CLI commands (§8.1),
  read-only controllers (§8.2).
- `llm.service.ts`: `LlmService.complete(context, request)`, the only entry point business code
  (M3) will call: resolve the model, filter candidates, persist intent, call the provider, persist the
  outcome and usage (§7.4).

## 4. Interfaces

### 4.1 Capabilities and context

```typescript
export const Capability = {
  LLM: 'llm',
  IMAGE_GENERATION: 'image_generation',
  IMAGE_EDIT: 'image_edit',
  VIDEO_GENERATION: 'video_generation',
  TTS: 'tts',
  TRANSCRIPTION: 'transcription',
  VISION_EVALUATION: 'vision_evaluation',
} as const;

export interface GenerationContext {
  readonly projectId: string;
  readonly contentItemId?: string;
  readonly generationJobId?: string; // M5
  readonly correlationId: string;
  readonly qualityTier: 'economy' | 'balanced' | 'premium';
  readonly deadlineAt?: Date;
}
```

### 4.2 `LlmProvider`

```typescript
export interface LlmRequest {
  readonly modelKey: string; // registry model key, e.g. 'deepseek/deepseek-v4-flash'
  readonly messages: readonly LlmMessage[]; // system | user | assistant, text only
  readonly maxOutputTokens: number; // required: bounds cost
  readonly temperature?: number;
  readonly topP?: number;
  readonly seed?: number;
  readonly stop?: readonly string[];
  readonly responseFormat?:
    { type: 'text' } | { type: 'json_schema'; name: string; schema: JsonSchema; strict: boolean };
  readonly dataPolicy?: { zeroDataRetention: boolean }; // default false (§7.2)
}

export interface LlmResult {
  readonly text: string;
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  readonly providerRequestId: string; // OpenRouter `id`
  readonly servedModel: string; // model the provider reports
  readonly usage: NormalizedUsage;
  readonly reportedCost: UsdAmount | null; // provider-reported, null when absent
  readonly latencyMs: number;
}

export interface LlmProvider {
  readonly providerKey: string; // 'openrouter' | 'mock'
  /** Parameters this adapter can send (intersected with the model's registry entry). */
  readonly supportedParameters: ReadonlySet<LlmParameter>;
  complete(
    request: LlmRequest,
    context: GenerationContext,
    signal: AbortSignal,
  ): Promise<LlmResult>; // throws ProviderError
}
```

- Input is validated by a zod schema in `ai-core` **before** any network call.
- `finishReason: 'length'` is a result, not an error: M3 decides whether a truncated script is usable.
  An **empty** completion with `length` is an error (`EMPTY_OUTPUT`, §4.3) because the prompt may
  still have been charged and nothing usable came back.
- No `generate()` with optional fields; image/video/TTS get their own interfaces in M4/M5.

### 4.3 Normalized errors (P4)

`ProviderError` carries `code`, `retryable`, `fallbackAllowed`, `retryAfterMs?`, `httpStatus?`,
`providerErrorType?`, `providerCode?`, `providerRequestId?`, `outcome` (`not_sent` | `rejected` |
`failed_after_acceptance` | `unknown`) and a **sanitized** message. It never carries prompt text:
OpenRouter moderation metadata includes `flagged_input` (prompt text), which is dropped.

| `ProviderErrorCode`        | OpenRouter source (status / `error_type` / metadata)                                                      | Retryable | Fallback allowed |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | :-------: | :--------------: |
| `AUTHENTICATION`           | 401, `authentication`                                                                                     |    no     |        no        |
| `PERMISSION_DENIED`        | 403 `permission_denied` (incl. guardrail block)                                                           |    no     |        no        |
| `CONTENT_POLICY`           | 403 `content_policy_violation`, `refusal`, moderation metadata; 200 with `finish_reason: content_filter`* |    no     |        no        |
| `PROVIDER_BUDGET_EXCEEDED` | 402 `payment_required` / `limit_source: openrouter_credits`; 403 with a budget `limit_source`             |    no     |        no        |
| `INVALID_REQUEST`          | 400 `invalid_request`, `invalid_prompt`, `unprocessable`, 413, 422; local validation                      |    no     |        no        |
| `CONTEXT_LENGTH_EXCEEDED`  | 400 `context_length_exceeded`, `string_too_long`, `token_limit_exceeded`                                  |    no     |        no        |
| `UNSUPPORTED_PARAMETER`    | local check against the registry (§7.1) before sending                                                    |    no     |        no        |
| `MODEL_NOT_FOUND`          | 404 `not_found`                                                                                           |    no     |        no        |
| `RATE_LIMITED`             | 429; 402 `in_flight_budget_exhausted` (`Retry-After` honoured)                                            |    yes    |       yes        |
| `PROVIDER_UNAVAILABLE`     | 502, 503, `provider_unavailable`, `provider_overloaded`                                                   |    yes    |       yes        |
| `TIMEOUT`                  | 408, 504, `timeout`, local deadline                                                                       |    yes    |       yes        |
| `NETWORK`                  | `fetch` failure before a response                                                                         |    yes    |       yes        |
| `EMPTY_OUTPUT`             | 200 with empty content (incl. `length` with no text)                                                      |    yes    |       yes        |
| `MALFORMED_RESPONSE`       | 200 whose body fails the response schema                                                                  |    yes    |        no        |
| `PROVIDER_ERROR`           | 500 `server`, `unmapped`, 200 with `error` and no usable choice                                           |    yes    |       yes        |

\* `content_filter` with partial text is still a policy outcome: no retry, no fallback.

- Unknown `error_type` values fall back to the HTTP status mapping (versioning page: clients must not
  fail on unknown enum values).
- Fallback means "another compatible model or provider may be tried" (AI_PROVIDER_STRATEGY §7). In
  M2 nothing acts on `retryable`/`fallbackAllowed`; M5/M7 job code will. The rules are now fixed and
  tested, so M7 cannot invent its own.
- The API error mapper maps `ProviderError` only when a request handler (none in M2) surfaces one;
  `docs/API_SPEC.md` gets the codes when M3 adds such handlers.

## 5. Money (P1, ADR-0012)

- **Representation:** `UsdAmount`, an immutable value holding a `bigint` of 10⁻¹⁸ USD units.
  Parsing accepts decimal strings and finite JSON numbers (OpenRouter's `usage.cost` is a double: it
  is parsed from its shortest round-trip string, e.g. `0.0012`, and stored as provider-reported).
- **Persistence:** PostgreSQL `NUMERIC(38,18)`, Prisma `Decimal @db.Decimal(38,18)`; the API returns
  amounts as decimal strings, never JSON numbers.
- **Currency** is an explicit `CHAR(3)` column; M2 accepts only `USD` (CHECK). Conversion is out of
  scope.
- **Rounding:** computation is exact to 10⁻¹⁸. Unit prices with more than 18 decimals (repeating
  fractions such as `0.0000000416666666666667`) are rounded half-even once, at import, and the
  original string is kept in `source_value` for audit.
- **Why not micros:** finding 1. `CLAUDE.md` allows "integer micros or Decimal"; `DATABASE.md` and
  `AI_PROVIDER_STRATEGY.md` mention `*Micros` fields, and are updated to the decimal form when M2 lands.

## 6. Database (one new migration `m2_ai_registry`, no M1 table changes)

### 6.1 Providers and models

```prisma
enum Capability { llm image_generation image_edit video_generation tts transcription vision_evaluation }
enum ProviderStatus { enabled disabled degraded }
enum QualityTier { economy balanced premium }

model AiProvider {
  id            String   @id @db.Uuid               // uuid v7, as in M1
  key           String   @unique                    // 'openrouter', 'mock'
  name          String
  kind          String                              // CHECK IN ('gateway','direct','mock')
  status        ProviderStatus @default(disabled)
  termsUrl      String?
  dataPolicyUrl String?
  notes         String?
  createdAt / updatedAt
  @@map("ai_providers")
}

model AiModel {
  id                  String   @id @db.Uuid
  providerId          String   @db.Uuid
  modelKey            String                         // routable id, e.g. 'deepseek/deepseek-v4-flash'
  canonicalSlug       String?                        // pinned checkpoint, e.g. '...-20260423'
  displayName         String
  capabilities        ModelCapability[]              // normalized table (DATABASE.md §5)
  supportedParameters String[]                       // e.g. ['seed','response_format','structured_outputs']
  inputModalities     String[]
  outputModalities    String[]
  contextLength       Int?
  maxOutputTokens     Int?
  qualityTier         QualityTier
  status              ProviderStatus @default(disabled)
  isFreeVariant       Boolean  @default(false)       // ':free': rate-limited, quotas not guaranteed
  rateLimitNotes      String?
  dataPolicyNotes     String?
  benchmarkScore      Decimal? @db.Decimal(5,2)
  lastTestedAt        DateTime?
  expiresAt           DateTime?                      // catalog `expiration_date`
  createdAt / updatedAt
  @@unique([providerId, modelKey])
  @@map("ai_models")
}

model ModelCapability {                              // (model_id, capability) primary key
  modelId    String     @db.Uuid
  capability Capability
  @@id([modelId, capability])
  @@map("ai_model_capabilities")
}
```

New models are always created `disabled`. Enabling is an explicit CLI step.

### 6.2 Prices (append-only)

```prisma
enum PriceMetric { input_tokens output_tokens cached_input_tokens cache_write_tokens reasoning_tokens request }
enum PriceSource { official_api official_page manual_estimate }

model ModelPrice {
  id              String   @id @db.Uuid
  modelId         String   @db.Uuid
  metric          PriceMetric
  unitPrice       Decimal  @db.Decimal(38,18)        // USD per single unit (token or request)
  sourceValue     String                             // exact string as published
  currency        String   @db.Char(3)               // 'USD' (CHECK)
  minPromptTokens Int      @default(0)               // prompt-size tier threshold
  effectiveFrom   DateTime                           // UTC
  source          PriceSource
  sourceUrl       String
  capturedAt      DateTime
  createdById     String?  @db.Uuid                  // operator, when entered via CLI
  @@unique([modelId, metric, minPromptTokens, effectiveFrom])
  @@index([modelId, effectiveFrom])
  @@map("ai_model_prices")
}
```

- The **active** price for a metric and tier at time `t` is the row with the greatest
  `effective_from <= t`. A price change is a new row; old rows stay.
- No row for a metric means **unknown**, never zero. A real zero (free variant) is an explicit row
  with `unit_price = 0`.
- Dynamic routers (`-1` sentinel) are refused at import: their price is unknown up front.

### 6.3 Invocations and usage (P2)

```prisma
enum InvocationStatus { started succeeded failed outcome_unknown }
enum CostStatus { reported estimated unknown }
enum UsageSource { provider_reported calculated manual }

model AiInvocation {
  id                String   @id @db.Uuid
  projectId         String   @db.Uuid                // FK projects
  contentItemId     String?  @db.Uuid                // composite FK (project_id, id) as in M1
  generationJobId   String?  @db.Uuid                // no FK until M5 (E4)
  correlationId     String
  idempotencyKey    String?  @unique                 // set by the M5 job layer
  capability        Capability
  providerId        String   @db.Uuid
  modelId           String   @db.Uuid
  servedModel       String?                          // what the provider reports
  providerRequestId String?                          // OpenRouter 'gen-…'
  status            InvocationStatus
  errorCode         String?                          // ProviderErrorCode
  errorMessage      String?                          // sanitized, ≤ 500 chars
  requestSummary    Json                             // parameters only: never messages or keys
  finishReason      String?
  latencyMs         Int?
  reportedCost      Decimal? @db.Decimal(38,18)
  estimatedCost     Decimal? @db.Decimal(38,18)
  costStatus        CostStatus
  currency          String   @db.Char(3)
  startedAt         DateTime
  completedAt       DateTime?
  @@index([projectId, startedAt])
  @@index([providerId, modelId, startedAt])
  @@map("ai_invocations")
}

model UsageRecord {                                  // append-only
  id           String   @id @db.Uuid
  invocationId String   @db.Uuid
  projectId    String   @db.Uuid                     // denormalized for reporting
  metric       PriceMetric
  quantity     BigInt
  unitPrice    Decimal? @db.Decimal(38,18)           // null when unknown
  cost         Decimal? @db.Decimal(38,18)           // quantity × unit price, or null
  priceId      String?  @db.Uuid                     // the ai_model_prices row used
  source       UsageSource
  recordedAt   DateTime
  @@index([projectId, recordedAt])
  @@map("ai_usage_records")
}
```

- **Prompts and completions are not stored** in M2. M3 stores scripts as versioned domain records;
  raw provider transcripts are not kept by default (data minimisation).
- `cost_status` on the invocation: `reported` if `usage.cost` was present; otherwise `estimated` if
  **every** metric with a non-zero quantity had a price; otherwise `unknown`. Both the reported and the
  estimated amount are kept (COST_STRATEGY §1: estimated vs actual separately).
- An invocation row is written **before** the call (`started`, intent persisted, CLAUDE.md §7) and
  updated once with the outcome. A crash in between leaves `started`; `LlmService` marks rows older
  than the request deadline as `outcome_unknown` on the next start. OpenRouter has no idempotency
  key for chat completions, so an `outcome_unknown` call may have been charged: it is never silently
  re-sent (M5 decides).

### 6.4 Integrity (P3, ADR-0011 style)

| Rule                                                                | Mechanism                                    | SQLSTATE |
| ------------------------------------------------------------------- | -------------------------------------------- | -------- |
| Price rows and usage records are immutable (no UPDATE, no DELETE)   | `BEFORE UPDATE OR DELETE` trigger            | `AC011`  |
| `currency = 'USD'`; `unit_price >= 0`; `quantity >= 0`; `cost >= 0` | CHECK                                        | `23514`  |
| `ai_providers.kind` in allowed set                                  | CHECK                                        | `23514`  |
| A model's provider and an invocation's model belong together        | composite FK `(provider_id, model_id)`       | `23503`  |
| An invocation's content item belongs to its project                 | composite FK `(project_id, content_item_id)` | `23503`  |
| `completed_at` set iff status ≠ `started`                           | CHECK                                        | `23514`  |

- `AC011` maps to `409 LEDGER_IMMUTABLE` (unreachable through the API: no write endpoints).
- **Locking:** the new tables are not part of the Version → Parent → Asset or Member → Project
  orders. Inserting an invocation takes `FOR KEY SHARE` on its project row. The owner-change protocol's
  no-op `UPDATE projects` takes `FOR NO KEY UPDATE`, which does not conflict with it. M2b adds a
  two-session test proving that an invocation insert never waits on an owner change, and that the
  M1 lock matrix stays 40/40 with 0 × `40P01`.
- `acf_app` keeps `SELECT/INSERT/UPDATE/DELETE` grants; the trigger blocks ledger UPDATE/DELETE, as
  for M1's guarded tables.

## 7. OpenRouter adapter

### 7.1 Request

- `POST {OPENROUTER_BASE_URL}/chat/completions`, `Authorization: Bearer <key>`, JSON, non-streaming.
- Sent fields: `model`, `messages`, `max_tokens`, and only those of `temperature`, `top_p`, `seed`,
  `stop`, `response_format` that the caller set.
- **Pre-check:** every set parameter must be in the model's registry `supported_parameters`
  (`response_format` with `json_schema` additionally needs `structured_outputs`), else
  `UNSUPPORTED_PARAMETER` without a network call (AI_PROVIDER_STRATEGY §4: do not route to a model
  that does not support the parameters).
- No `HTTP-Referer` / `X-OpenRouter-Title` headers by default: they only serve public app rankings and
  would identify the deployment. Opt-in via config.
- Timeout: `AbortSignal.any([callerSignal, AbortSignal.timeout(OPENROUTER_TIMEOUT_MS)])`.

### 7.2 Routing preferences (P5)

```json
{ "provider": { "data_collection": "deny", "require_parameters": true, "allow_fallbacks": true } }
```

- `data_collection: "deny"`: never route to upstream providers that may train on prompts
  (AI_PROVIDER_STRATEGY §10).
- `require_parameters: true`: only endpoints that honour every sent parameter, so structured output is
  never silently ignored (verification §1).
- `allow_fallbacks: true` lets OpenRouter retry **another host of the same model** before answering.
  This preserves the model and its parameters, so it is compatible with §7 of the strategy.
- The `models` array (cross-model fallback) is **never** sent: switching models silently would
  change output requirements.
- `zdr: true` is sent when `dataPolicy.zeroDataRetention` is set. Project-level policy is a later
  milestone; M2 provides the switch.

### 7.3 Response handling

1. Non-2xx: parse `{ error: { code, message, metadata } }`, map per §4.3, read `Retry-After`.
2. 2xx: validate with a lenient zod schema (unknown fields ignored). If it has a top-level `error`, or
   `choices[0].finish_reason === 'error'`, it is a failure after acceptance (`outcome:
failed_after_acceptance`); usage, if present, is still recorded because it may be charged.
3. Usage: `prompt_tokens` → `input_tokens` minus `cached_tokens`; `cached_tokens` →
   `cached_input_tokens`; `cache_write_tokens` → `cache_write_tokens`; `completion_tokens` →
   `output_tokens`, with `reasoning_tokens` → `reasoning_tokens` split out of it when the model has a
   separate `internal_reasoning` price. `usage.cost` → `reportedCost`. Two points are **assumptions,
   not yet verified** (A1, A2 below); the estimate is only a cross-check whenever `usage.cost` is
   present.
4. `usage.is_byok === true` → `MALFORMED_RESPONSE` in M2 (BYOK is out of scope; reported cost would
   not be the full cost).
5. Never log request bodies, response text, or headers; the existing redaction (`@acf/config`
   `redact`) gains `authorization` and `openrouter_api_key` patterns, with tests.

### 7.4 `LlmService.complete` flow

1. Load the model by key; require model and provider `enabled`, capability `llm`, provider configured.
2. Candidate filter (routing.ts): enabled, capability, parameters, quality tier ≥ requested. M2 has
   exactly one candidate per request because callers name the model; the explanation is still
   returned and stored in `request_summary`. Scoring (cost, quality, latency) waits for benchmarks.
3. Insert `ai_invocations` (`started`) — committed before the call.
4. Call the provider with the deadline.
5. In one transaction: update the invocation, insert `ai_usage_records` with prices active at
   `started_at` (tier chosen by prompt tokens).
6. Return `LlmResult` or throw `ProviderError`.

## 8. Operator surface

### 8.1 CLI (`pnpm ai:registry …`, runs with `DATABASE_URL` as `acf_app`)

| Command                                                                                              | Effect                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider list` / `provider set-status <key> <status>`                                               | List; enable/disable/degrade a provider                                                                                                                                                                                                                                |
| `model list [--provider]` / `model show <key>`                                                       | List models with active prices                                                                                                                                                                                                                                         |
| `model import-openrouter <modelKey…> [--tier] [--apply]`                                             | Fetch the public catalog, show a diff (new model, metadata, price rows); writes only with `--apply`; new models `disabled`                                                                                                                                             |
| `model set-status <key> <status>`                                                                    | Enable/disable a model                                                                                                                                                                                                                                                 |
| `price add <modelKey> <metric> <usdPerUnit> --source --url [--effective-from] [--min-prompt-tokens]` | Manual price row (e.g. `manual_estimate`)                                                                                                                                                                                                                              |
| `smoke llm <modelKey> --max-cost-usd <n>`                                                            | **Paid** call; refuses unless `ACF_PAID_SMOKE=1` and `OPENROUTER_API_KEY` are set, the model has prices for input and output, and the worst-case estimate (prompt tokens ≤ 200, `max_tokens` ≤ 64) is ≤ the cap. Records the invocation in a dedicated `smoke` project |

The import never enables a model and never deletes price rows. Repeating it with unchanged
prices writes nothing.

### 8.2 Read-only API (base `/api/v1`)

| Endpoint                  | Unauth | Any authenticated user | Notes                                                                              |
| ------------------------- | :----: | :--------------------: | ---------------------------------------------------------------------------------- |
| `GET /ai/providers`       |  401   |           ✓            | `key`, `name`, `kind`, `status`, `configured` (boolean); never credentials         |
| `GET /ai/models`          |  401   |           ✓            | Filters `capability`, `status`, `qualityTier`; paginated; active prices as strings |
| `GET /ai/models/:modelId` |  401   |           ✓            | Plus price history                                                                 |

Registry data is not project-scoped, so there is no 404/403 split. The permission matrix gains these
rows (unauthenticated 401; outsider, viewer, editor, owner 200).

### 8.3 Configuration (`@acf/config` api-env)

| Variable                     | Rule                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`         | Optional. If set: must start with `sk-or-v1-`. If unset, the provider reports `configured: false` and is never called |
| `OPENROUTER_BASE_URL`        | Default `https://openrouter.ai/api/v1`; must be `https:` in production (tests use a local `http:` fixture server)     |
| `OPENROUTER_TIMEOUT_MS`      | Default 120 000; 1 000–600 000                                                                                        |
| `OPENROUTER_APP_ATTRIBUTION` | Default `false`; when `true`, `OPENROUTER_APP_URL` / `OPENROUTER_APP_TITLE` are required                              |
| `ACF_PAID_SMOKE`             | CLI only; never read by the API                                                                                       |

Keys never reach the web app (`web-env` does not accept them; a test asserts this) or logs.

## 9. Testing

| Layer                  | What                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (`ai-core`)       | `UsdAmount` (parse, add, multiply, rounding, double input); cost estimation incl. tiers, cache metrics, missing prices → unknown; routing filter; error policy table; request validation                                                                                                                                                                  |
| Contract (adapter)     | Adapter against a local `node:http` fixture server: request shape and headers, every row of §4.3, 200-with-error, empty `length`, BYOK, unknown fields/enums, timeout, abort, `Retry-After`. Fixtures are derived from the documented schemas (verification record) and marked so; real fixtures are recorded from the manual smoke run once a key exists |
| Network guard          | The unit and integration projects install a `fetch`/`undici` dispatcher that throws on any non-loopback host, so no test can reach OpenRouter                                                                                                                                                                                                             |
| Mock provider          | `MockLlmProvider`: scripted results/errors, deterministic usage; used by `LlmService` and M3 tests                                                                                                                                                                                                                                                        |
| Integration (database) | Migration from empty and from `init_m1`; CHECKs, composite FKs, `AC011`; trigger/CHECK presence and drift; the lock-interaction test (§6.4); M1 lock matrix re-run                                                                                                                                                                                        |
| Integration (API)      | `LlmService` with the mock: invocation lifecycle, usage rows, cost status, `outcome_unknown` sweep; registry endpoints; permission-matrix rows; CLI import against a fixture catalog                                                                                                                                                                      |
| Paid smoke             | Manual only (§8.1); never in CI                                                                                                                                                                                                                                                                                                                           |

## 10. ADR changes

- **ADR-0012 (new, proposed):** money as exact decimal USD; prices and usage as an append-only ledger
  with reported/estimated/unknown cost; registry as data edited by CLI.
- ADR-0004: status note only ("implemented in M2 for LLM via OpenRouter").
- Docs updated when M2 lands: `DATABASE.md` (new tables, decimal money), `API_SPEC.md` (registry
  endpoints, `LEDGER_IMMUTABLE`), `AI_PROVIDER_STRATEGY.md` (implemented contract, P5 defaults),
  `COST_STRATEGY.md` (decimal), `LOCAL_DEVELOPMENT.md` (CLI, smoke test), `.env.example`.

## 11. Decisions for the owner, and risks

### Decisions (approved as recommended, 2026-11-17)

| ID  | Question                                     | Recommendation                                                                                                                                                    | Alternative                                                                          |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1  | Money representation                         | `NUMERIC(38,18)` USD, `UsdAmount` (BigInt)                                                                                                                        | Integer nano-USD (`BIGINT`, 10⁻⁹): simpler, but rounds sub-nano unit prices          |
| P2  | Granularity                                  | Invocation row + per-metric usage rows                                                                                                                            | Usage rows only (DATABASE.md as written): reported per-call cost has nowhere to live |
| P3  | Immutable prices/usage via trigger (`AC011`) | Yes                                                                                                                                                               | Application-only rule                                                                |
| P5  | OpenRouter defaults                          | `data_collection: deny`, `require_parameters: true`, `allow_fallbacks: true`, `zdr` opt-in                                                                        | `zdr: true` by default (stricter; fewer models available)                            |
| P7  | No model-calling endpoint in M2              | Yes; first caller is M3's script job                                                                                                                              | A synchronous test endpoint (conflicts with "expensive operations are async jobs")   |
| S1  | Development seed (`pnpm db:seed`)            | `openrouter` (disabled unless a key is set) + the three catalog candidates in the verification record, `disabled`, with imported prices; plus the `mock` provider | No AI seed                                                                           |

### Assumptions to verify (first manual smoke run, M2c/M2d)

| ID  | Assumption                                                   | Basis                                                                                                       | If wrong                                           |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A1  | `prompt_tokens` includes `cached_tokens` (OpenAI convention) | OpenAI-compatible schema; not stated explicitly on the pages read                                           | Mapping change in one function; estimates only     |
| A2  | `completion_tokens` includes `reasoning_tokens`              | Errors page: an all-reasoning `length` response has `reasoning_tokens` "close to" `completion_tokens`       | Same                                               |
| A3  | `usage.cost` is USD (not an internal credit unit)            | Generation endpoint documents `total_cost` "in USD"; `usage.cost` itself only says "Cost of the completion" | Reported cost re-labelled; smoke run compares both |

### Risks

| ID  | Risk                                                                                | Mitigation                                                                                         |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R1  | OpenRouter changes response fields or error types without notice                    | Lenient parsing, status-code fallback, contract tests; changelog watch is an operator task         |
| R2  | Fixtures derived from docs differ from real responses                               | Recorded fixtures from the first manual smoke run replace or extend them                           |
| R3  | Reported cost absent or BYOK → estimate only                                        | `cost_status` makes it explicit; unknown is never 0                                                |
| R4  | A timed-out call was processed and charged                                          | `outcome_unknown`; never re-sent automatically; reconciliation via `GET /generation` is M7 work    |
| R5  | Commercial-use terms differ per model, not per gateway                              | `data_policy_notes` per model; models stay `disabled` until the owner reviews terms and benchmarks |
| R6  | Free variants (`:free`) have small daily quotas (50/day under 10 credits purchased) | `is_free_variant` flag; never used as production capacity (CLAUDE.md §2.14)                        |
| R7  | No benchmark data yet                                                               | No defaults chosen; benchmarking is M8 / owner decision per model                                  |

## 12. Implementation plan (after approval; each slice reviewed before the next)

| Slice | Scope                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2a   | `packages/ai-core`: capabilities, interfaces, errors and policy table, `UsdAmount`, pricing/cost, routing filter, mock provider; unit tests; ESLint import rule; ADR-0012 |
| M2b   | Migration `m2_ai_registry` (tables, CHECKs, composite FKs, `AC011` trigger, grants); presence/drift tests; direct-SQL tests; lock-interaction test; M1 lock matrix re-run |
| M2c   | OpenRouter adapter, config validation, redaction; fixture server and contract tests; network guard                                                                        |
| M2d   | `RegistryService`, `LlmService`, CLI (incl. import and paid smoke), read-only endpoints, OpenAPI, permission-matrix rows, seed, docs                                      |
