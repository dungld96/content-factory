# P5 Design Review Package — Second gateway (MixRoute) and gateway switch

- Status: **Revision 1, scope approved by the owner (2026-11-26)**: "thêm gateway mixroute.ai,
  có thể đổi gateway trong setting"; options chosen: **phased** delivery, **per-task routes plus a
  bulk gateway switch**. Slice P5a implemented (§8).
- Date: 2026-11-26
- Baseline: post-MVP R redesign. Provider facts: `docs/design/p5/mixroute-verification.md`.
  Architecture: ADR-0023.

Routing was already per task (each task points at one model of one provider; P1 O4). P5 adds a
second gateway behind the same capability interfaces and a Settings action that moves every task
to one gateway in one step.

## 0. Decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                  | Section |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| G1  | **MixRoute is a second gateway** (`ai_providers.key = mixroute`, kind `gateway`). Adapters in `@acf/ai-core/mixroute`, wired only in `packages/ai-runtime/src/providers` (ESLint rule extended). Key in the environment: `MIXROUTE_API_KEY` (P1 O2 unchanged); `MIXROUTE_BASE_URL`, `MIXROUTE_TIMEOUT_MS`, `MIXROUTE_IMAGE_TIMEOUT_MS`                                                    | §1      |
| G2  | **Phased**: P5a text (script, storyboard) and Seedream image; P5b Seedance video; TTS and Veo after their docs are read or a live call confirms them                                                                                                                                                                                                                                      | §8      |
| G3  | **Cost**: MixRoute reports no per-call cost. Its calls are always recorded `estimated` from registry prices (`unknown` when unpriced, never zero). Reconciliation from MixRoute's usage logs is out of scope (separate token, no request-id filter, 7-day retention)                                                                                                                      | §3      |
| G4  | **Models**: MixRoute's `GET /models` lists ids only, so a **curated catalog in code** (`apps/api/src/ai/providers/mixroute-catalog.ts`) holds the verified ids, limits and prices (`official_page`, page URL per model, checked date). Imported through the same Settings import (new `gateway` field) and the seed; new models start disabled                                            | §2      |
| G5  | **Data policy**: MixRoute has no per-request zero-data-retention or no-training routing. A route with ZDR can never point at MixRoute (`422`); the adapters refuse a ZDR request before sending                                                                                                                                                                                           | §4      |
| G6  | **Gateway switch**: `POST /ai/gateways/:providerKey/switch` (operators). Preview suggests per task the target gateway's equivalent model (same family, else the only candidate); the operator may change or keep any task; apply routes all chosen tasks **in one transaction**, one audited `route_set` per task. Tasks without a routable model, or needing ZDR the gateway lacks, stay | §5      |
| G7  | **Key test**: `GET /models` (free, authenticated). MixRoute reports no limit or usage                                                                                                                                                                                                                                                                                                     | §1      |
| G8  | **Seedream specifics**: one image per call (`maxImages: 1`), up to 10 references, ratios 9:16 / 1:1 / 16:9, tiers 1.5K and 2K only, no seed. Explicit `WIDTHxHEIGHT` sizes all within the "std" price tier; `watermark: false`; `response_format: b64_json` (no URL fetch)                                                                                                                | §2      |

**Out of scope:** keys in the UI; MixRoute video/TTS (P5b+); cost reconciliation; automatic
cross-gateway fallback (AI_PROVIDER_STRATEGY §6 is unchanged: no automatic fallback).

## 1. Adapters (G1, G7)

- `MixRouteLlmProvider`: non-streaming `POST /chat/completions`, OpenAI body (no OpenRouter
  `provider` object). Usage from `usage` (+ `prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens` when present). `reportedCost: null` always.
- `MixRouteImageProvider`: Seedream body (§2), base64 decoding (a data-URL prefix is accepted).
- Errors: OpenAI error body; status table in the verification record §5. `403` (token group
  disabled / quota) → `PROVIDER_BUDGET_EXCEEDED` (not retried). Timeouts and network errors after
  sending → outcome `unknown` (may be charged).
- `checkMixRouteKey`: `GET /models` → `valid` / `rejected` (401, 403) / `unreachable`.

## 2. Registry data (G4, G8)

| Task                | MixRoute model (seeded disabled)                                                     | Recorded prices                                                                   |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Script / storyboard | `claude-haiku-5-5`, `gemini-3.5-flash-lite`, `gemini-3.5-flash`, `deepseek-v4-flash` | per token from the per-1M prices; Haiku's > 100K tier as `minPromptTokens 100001` |
| Keyframe images     | `doubao-seedream-5-5-261028`                                                         | `output_images` 0.0195, `input_images` 0.0075                                     |

Seedream sizes: 1.5K → 864×1536 / 1536×1536 / 1536×864; 2K → 1152×2048 / 1600×1600 / 2048×1152
(1:1 at 2K is held at 1600×1600 so it stays ≤ 2.61 MP; 1K is not offered because 9:16 and 16:9
fall under the 921,600 px minimum).

`RegistryAdminService.applyOpenRouterImport` / `applyOpenRouterImageImport` take an optional
provider row, price source and data-policy note, so the same writers serve both gateways.

## 3. Cost (G3)

No schema change: `LlmService` / `ImageService` already record `estimated` when the adapter
reports no cost. Budgets reserve from the same estimates. The Settings switch preview says
that MixRoute costs are estimates.

## 4. Data policy (G5)

`supportsZeroDataRetention(providerKey)` is false for `mixroute`. `PUT /ai/routes/:task` with
`zeroDataRetention: true` on a MixRoute model → `422 MODEL_NOT_ROUTABLE`; the switch keeps such a
task (`keptBecause: zdr_required`).

## 5. API (G6)

| Endpoint                                | Caller   | Rules                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /ai/gateways/:providerKey/switch` | operator | `{ apply, choices? }`; `choices[task]` = a candidate model key or `null` (keep). Response: per task `current`, `candidates`, `target`, `keptBecause` (`already_on_gateway` / `no_candidate` / `zdr_required` / `not_chosen`), `action` when applied. `404` unknown provider; `422` not a gateway or a choice outside the candidates |
| `POST /ai/models/import`                | operator | New `gateway: openrouter \| mixroute` (default `openrouter`). MixRoute: catalogs `llm` and `image` only (`422` otherwise); keys without author; no network call                                                                                                                                                                     |
| `PUT /ai/routes/:task`                  | operator | Unchanged, plus the ZDR rule (§4). The web sends `providerKey` so a key offered by two gateways is never ambiguous                                                                                                                                                                                                                  |

Candidates for a task: enabled models of the target gateway with the task's capability, the
gateway enabled and configured for that capability (same rules as `PUT /ai/routes/:task`).

## 6. Web

- Settings › AI: a **Switch gateway** card (operators, shown when two or more gateways exist):
  choose the gateway, Preview, adjust each step (or keep it), Apply. Steps that cannot move show
  why. The route pickers show the provider next to each model when several gateways are usable.
- Settings › Models › Import models: a **Gateway** field; MixRoute offers text and image.
- EN and VI strings (`gw.*`, `import.gateway`, `import.gw.*`, `import.keysHintMixroute`).

## 7. Tests

- Contract tests (`packages/ai-core/src/mixroute/contract.test.ts`, local fixture server): request
  shape and headers, usage, every error class, timeout as `unknown`, ZDR refused unsent, key
  check, Seedream size table and refusals.
- Unit: switch planner (`gateway-switch.test.ts`), curated catalog (`mixroute-catalog.test.ts`),
  env (`api-env.test.ts`).
- API integration (`apps/api/test/ai/gateway-switch.integration.test.ts`): seeded gateway and
  models, preview writes nothing, apply in one step with audit, choice/permission/unknown-gateway
  refusals, ZDR rule, curated import. Permission matrix row added; seed counts updated.

## 8. Slices and results

| Slice | Scope                                                     | State                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P5a   | G1–G8 for text and Seedream image; switch; Settings; docs | Implemented 2026-11-26. Lint, typecheck, unit (2,601) and API integration (AI suite 93, permission matrix 666) pass; failures elsewhere are the known Windows environment issues (backup shell scripts, caption font render, Prisma drift spawn) |
| P5b   | Seedance video adapter (async submit / poll / download)   | Waits for owner review of P5a                                                                                                                                                                                                                    |
| P5c   | TTS, Veo and other video families                         | Waits for verified docs or a live call                                                                                                                                                                                                           |

## 9. Risks

| ID  | Risk                                                                           | Mitigation                                                                                            |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| R1  | Fixtures come from documentation, not live traffic                             | First paid smoke run (`ACF_PAID_SMOKE=1`, capped) records real responses; extend the fixtures         |
| R2  | Estimated cost differs from MixRoute's charge                                  | Prices from the official pages with source URL and date; refresh the curated catalog when they change |
| R3  | Upstream data policy is per provider, no ZDR                                   | ZDR routes cannot move (G5); terms and data-policy links on the provider card                         |
| R4  | `gemini-3.5-flash-lite` page: "pricing varies by tier" vs a flat listing       | Recorded as a warning on import; check the first invoices                                             |
| R5  | Same model family behaves differently across gateways (e.g. structured output) | Models start disabled; run the paid smoke test and a short benchmark before routing                   |

## 10. Revision 2 — import any MixRoute model (2026-11-26)

Found in live testing: the import accepted only the five verified models, all already seeded, so
an operator could add nothing. Changes:

- The import reads the key's model list (`GET /models`, free; `MODEL_LISTINGS`,
  `createModelListings`). **Text**: any listed id imports, disabled, **without prices** (cost
  `unknown` until an operator adds prices) and with a warning that limits and structured output
  are unverified. **Image**: only Seedream ids (the adapter's request format), with Seedream's
  limits. Unlisted ids are refused ("not offered by MixRoute for this key").
- A verified model the key does not list imports with a warning that calls will fail.
- Live check on the development key: it lists 15 models (`deepseek-v4-pro`, `qwen3.6-flash`,
  `gpt-5*`, `kimi-k2.5`, `gemini-2.5-flash`, …) and **not** `claude-haiku-5-5`,
  `gemini-3.5-flash` or `doubao-seedream-5-5-261028`: model access depends on the MixRoute
  account.
