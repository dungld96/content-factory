# P1 Design Review Package — OpenRouter Settings UI

- Status: **Revision 1, approved by the owner (2026-11-20)** by standing instruction ("follow your
  recommendations until all packages are complete"): O1–O7 as proposed. Slices P1a–P1c
  implemented (§10); API integration and E2E verification pending.
- Date: 2026-11-20
- Baseline: MVP complete; P3 and P2a implemented. Input: `docs/post-mvp/POST_MVP_AUDIT.md` §A1,
  §B1, §C1; owner decision: operators named by an environment allowlist.

P1 puts the AI registry in the web app without moving the API key out of the server environment.
Everything the operator CLI writes today stays possible from the CLI; the UI calls the same
service methods.

## 0. Decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                              | Section |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| O1  | **Operators** are the users listed in `OPERATOR_EMAILS` (API environment, comma-separated, case-insensitive). Only operators change providers, models and routes over HTTP (`403 FORBIDDEN` otherwise). `GET /auth/me` gains `isOperator` (additive)                                                                  | §2      |
| O2  | **The key stays in the environment.** The UI shows per provider whether it is configured (for **any** capability: today only the LLM map is checked); rotating the key is the documented operator step                                                                                                                | §3      |
| O3  | **Test connection**: `POST /ai/providers/:providerKey/test` (operator) reads OpenRouter's free `GET /key` and reports `valid`, `rejected`, `unreachable` or `not_configured`, with the key's remaining limit and usage when given. No paid call                                                                       | §3      |
| O4  | **Routes over HTTP**: `GET /ai/routes` (signed-in) and `PUT /ai/routes/:task` (operator). The API accepts only an enabled model of an enabled, configured provider with the task's capability                                                                                                                         | §4      |
| O5  | **Status over HTTP**: `PATCH /ai/providers/:providerKey` (`status`) and `PATCH /ai/models/:modelId` (`status`, `schemaMode`) (operator)                                                                                                                                                                               | §4      |
| O6  | **Audit**: every registry change (UI or CLI) appends a row to `ai_registry_events` (actor, action, target, before, after); append-only (`AC011`). One migration                                                                                                                                                       | §5      |
| O7  | **Settings UI**: an "AI providers & models" section — providers (status, configured, Test), routes (operators pick from eligible models), models by capability (status, tier, limits, active prices, price source and date). Model pickers in the content workspace hide models of disabled or unconfigured providers | §6      |

**Out of scope:** entering or storing keys through the UI, price edits and catalog imports
(append-only, sourced data: CLI), paid smoke tests (CLI), circuit control in the UI.

## 1. Acceptance

| Criterion                                                          | Evidence                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| An operator changes a route in the UI and the next request uses it | API integration: `PUT /ai/routes/script_generation` then a generate request records that model; E2E later                           |
| Non-operators cannot change the registry                           | Permission matrix: owner/editor/viewer `403`, operator `200`                                                                        |
| The key never leaves the server                                    | API integration: no response or log line of the new endpoints contains the key (redaction test pattern)                             |
| Test connection makes no paid call                                 | Contract test against a `GET /key` fixture; the adapter calls only that path                                                        |
| Every change is attributable                                       | Database: `ai_registry_events` append-only; API/CLI integration: one event per change with actor (CLI: null actor, `source: 'cli'`) |
| Pickers offer only usable models                                   | Unit: picker filter; existing E2E unchanged                                                                                         |

## 2. Operators (O1)

- `packages/config/src/api-env.ts`: `OPERATOR_EMAILS` (optional, comma-separated emails,
  normalised to lower case). Empty: nobody is an operator (the CLI still works).
- `apps/api/src/auth/operator.ts`: `isOperator(actor)`, `requireOperator(actor)` (→ `403
FORBIDDEN`, message "Only platform operators can change AI settings").
- `GET /auth/me`: `isOperator: boolean` added to `meResponseSchema`.

## 3. Credential status and test (O2, O3)

- `RegistryService.isConfigured(providerKey)` checks the LLM, image, video and TTS maps.
- Key check: `checkOpenRouterKey(config, fetchFn, signal)` in `packages/ai-core/src/openrouter/`
  calls `GET {baseUrl}/key` with the same `Authorization: Bearer` header as every adapter.
  - `200` → `valid`, with `limit_remaining`, `usage` and `is_free_tier` when present (parsed
    defensively: missing or non-numeric fields become `null`).
  - `401`/`403` → `rejected`; network error or timeout → `unreachable`; other statuses →
    `unreachable` with the status.
  - Verified source: `docs/design/m2/openrouter-verification.md` §3 (`GET /key` reports
    `limit_remaining`, `usage*`, `is_free_tier`; official `api_reference/limits.md`, checked
    2026-11-17). Re-checking the live page was not possible from the P1 session (`openrouter.ai`
    is outside its network allowlist); the parser therefore requires no field.
- `packages/ai-runtime/src/providers/key-checks.ts`: `createKeyChecks(env)` →
  `Map<providerKey, () => Promise<KeyCheckResult>>` (vendor code stays in the providers folder).
- Response `providerKeyCheckSchema`: `{ providerKey, result, limitRemaining, usage, isFreeTier,
httpStatus, checkedAt }`. Never contains the key or headers.

## 4. Routes and status (O4, O5)

`RegistryAdminService` becomes a Nest provider (`AiModule`), still constructed by the CLI; every
write method takes an optional `actor` and records an event (§5).

| Endpoint                           | Caller    | Rules                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /ai/routes`                   | signed-in | Every task (`script_generation`, `storyboard_generation`, `image_generation`, `video_generation`, `tts_generation`) with its model (`modelKey`, `displayName`, `status`), provider (`key`, `status`, `configured`), `zeroDataRetention`; `null` when no route |
| `PUT /ai/routes/:task`             | operator  | `{ modelKey, providerKey?, zeroDataRetention? }`. `422 MODEL_NOT_ROUTABLE` unless the model has the task's capability and model and provider are enabled and configured (stricter than the CLI, which may route a disabled model)                             |
| `PATCH /ai/providers/:providerKey` | operator  | `{ status }`                                                                                                                                                                                                                                                  |
| `PATCH /ai/models/:modelId`        | operator  | `{ status?, schemaMode? }` (`schemaMode` only for `llm` models: `422` otherwise)                                                                                                                                                                              |

Jobs already queued keep their model (stored on the job); a change applies to new requests.

## 5. Audit (O6)

Migration `p1_registry_events`:

```text
ai_registry_events
  id          uuid  PK (uuid v7)
  actor_id    uuid  NULL  FK users      -- null: the CLI
  source      varchar(8)   'api' | 'cli' (CHECK)
  action      varchar(32)  'provider_status' | 'model_status' | 'model_schema_mode' |
                           'model_min_billed_seconds' | 'route_set' | 'price_added' |
                           'model_imported' (CHECK)
  target      varchar(300) provider key, model key or task
  before      jsonb NULL
  after       jsonb NULL
  created_at  timestamptz(3)
  index (created_at DESC), index (actor_id)
  trigger: append-only (acf_ai_ledger_append_only, AC011)
```

`GET /ai/registry-events?limit&cursor` (operator) lists them newest first.

## 6. Web (O7)

- `apps/web/src/app/(studio)/settings/ai-settings.tsx` (client): providers card (status pill,
  configured, Test connection result, enable/disable for operators), routes table (select of
  eligible models per task for operators), models table filtered by capability (status toggle for
  operators; tier, context/limits, active prices with unit and source date; voices count for TTS),
  last 20 registry events for operators.
- `settings/page.tsx` loads `/ai/providers`, `/ai/routes`, `/ai/models?limit=100` and `isOperator`.
- Content workspace pickers (`content/[contentId]/page.tsx`) and the voice-profile model list
  drop models whose provider is disabled or not configured (`lib/model-options.ts`, unit-tested).

## 7. Tests

| Level           | Tests                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit            | `OPERATOR_EMAILS` parsing; key-check parser (valid/rejected/unreachable/missing fields); picker filter                                           |
| Contract        | `checkOpenRouterKey` against fixtures (200 with fields, 200 without, 401, network error); only `GET /key` is called                              |
| Database        | `ai_registry_events` append-only and CHECKs; schema-objects trigger list                                                                         |
| API integration | Routes and status endpoints (operator vs others, rules, events written); `isOperator` in `/auth/me`; no key in responses; permission matrix rows |
| CLI integration | Existing registry CLI tests pass; a CLI route change writes a `cli` event                                                                        |

## 8. Implementation plan

| Slice | Content                                                                |
| ----- | ---------------------------------------------------------------------- |
| P1a   | O1 operators, O2 configured fix, O4/O5 endpoints, O6 audit (migration) |
| P1b   | O3 key check (adapter, runtime wiring, endpoint)                       |
| P1c   | O7 Settings UI and picker filter; docs                                 |

## 9. Risks

- **A global change affects every project**: limited to operators, recorded, and applies only to
  new requests.
- **`GET /key` fields may differ from the record**: the parser requires none; the result still
  says valid/rejected from the HTTP status.
- **Operator list in the environment**: changing it needs an API restart (same as the key);
  documented in DEPLOYMENT.md.

## 10. Deviations and results found during implementation

| Item                                  | Planned                        | Done                                                                                                                             | Why                                                                            |
| ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Model DTO                             | Unchanged                      | Gains `schemaMode` (additive)                                                                                                    | The Settings UI shows and changes it                                           |
| Audit CHECK                           | Source and action known        | Also: `api` rows have an actor, `cli` rows none (`ai_registry_events_actor_matches_source`)                                      | Every API change is attributable                                               |
| `min_billed_seconds`, prices, imports | Audited                        | Audited as `cli` (CLI-only operations)                                                                                           | —                                                                              |
| Test connection in tests              | Fixture server through the API | The API test covers `not_configured` and `403`; the HTTP behaviour is covered by the adapter contract test (`key-check.test.ts`) | The API test app points at the real OpenRouter host, which tests may not reach |
| E2E                                   | Route change in the UI         | **Not written**                                                                                                                  | Follow-up with the full stack                                                  |

Verification: lint, typecheck, format, build and unit tests pass; database integration **run**
(300 passed, incl. `ai_registry_events` and the schema inventory); API integration tests
(`registry-settings.integration.test.ts`, CLI audit, permission matrix) written, **not run** (the API
suite needs S3 storage in the implementation session).

### Settings redesign (2026-11-21)

Settings is split into sections with their own URL (`/settings?section=general|voices|ai|models|
activity|system`; a menu on small screens): a summary of providers, routes and models; provider
cards with status, credentials and Test connection; a routes table that says why a step cannot run
("No API key configured", "Model disabled", …); a model catalogue with capability tabs, search,
status filter and prices in readable units (per 1M tokens, per image, per second, per megapixel,
per 1M characters, computed exactly from the stored per-unit decimals); and a readable change log.
The price DTO gains `variant` (additive) so resolution/audio tiers are labelled.

## 11. Revision 2 — P1d: model import and prices in Settings (approved 2026-11-21)

Owner decisions of 2026-11-21: the API key stays in the environment (O2 unchanged); importing
models and adding prices move from the CLI into Settings, for operators.

| Change                                                                                                                                                                                                       | Where                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `POST /ai/models/import` (preview or apply) and `POST /ai/models/:modelId/prices`, operators only (`requireOperator`)                                                                                        | `RegistrySettingsService`, `registry.controller.ts` |
| The planners and writers are the CLI's (`planOpenRouter*Import`, `RegistryAdminService.apply*`/`addPrice`); writes now carry the operator (`RegistryChangeBy`), so events record `source: api` and the actor | `registry-admin.service.ts`                         |
| Settings › Models: "Import from OpenRouter" (catalog, keys, tier, Preview → Import) and "Add price" per model                                                                                                | `settings/model-admin.tsx`                          |

Unchanged: new models start disabled; prices are append-only; enabling a model and routing stay
separate decisions (O4, O5). Tests: API integration against a local catalog stand-in (preview
writes nothing; apply creates a disabled model with prices and an `api` event; price append;
`403` for non-operators; `502` without a catalog) and permission-matrix rows.
