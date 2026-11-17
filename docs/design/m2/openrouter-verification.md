# OpenRouter verification record (M2 design input)

- Retrieved: 2026-11-17 (UTC), from the official documentation (`https://openrouter.ai/docs/…`,
  Markdown variants listed in `https://openrouter.ai/docs/llms.txt`) and the public, unauthenticated
  model catalog (`GET https://openrouter.ai/api/v1/models`).
- No API key was used and no paid call was made.
- These are facts **as of the retrieval date**. OpenRouter states that non-breaking changes ship
  without notice (API Versioning page), so the adapter must ignore unknown fields and must not fail
  on unknown enum values. Prices are registry data, re-imported with a new effective date (design
  package §6), never constants in code.

## 1. API surface

| Fact                                                                                                                                                                                                  | Source page                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Single stable version `v1`, base URL `https://openrouter.ai/api/v1`; no version headers or date pinning                                                                                               | `api_reference/versioning.md`                                  |
| Auth: `Authorization: Bearer <key>`; API keys start with `sk-or-v1-`                                                                                                                                  | `api_reference/authentication.md`                              |
| `HTTP-Referer` and `X-OpenRouter-Title` headers are **optional** (app attribution for public rankings)                                                                                                | `api_reference/authentication.md`                              |
| `POST /chat/completions` (OpenAI-compatible): `model`, `messages`, `max_tokens` / `max_completion_tokens`, `temperature`, `top_p`, `seed`, `stop`, `response_format`, `provider`, `stream`, `user`, … | `api/api-reference/chat/create-a-chat-completion.md` (OpenAPI) |
| The request schema has **no** usage opt-in field: `usage` is part of every response                                                                                                                   | same                                                           |
| Response: `id`, `model`, `choices[].message`, `choices[].finish_reason` ∈ `stop`, `length`, `tool_calls`, `content_filter`, `error`, `null`; `usage`                                                  | same (`ChatResult`, `ChatChoice`, `ChatFinishReasonEnum`)      |
| `usage`: `prompt_tokens`, `completion_tokens`, `total_tokens` (required); `prompt_tokens_details.cached_tokens`, `cache_write_tokens`; `completion_tokens_details.reasoning_tokens`                   | same (`ChatUsage`)                                             |
| `usage.cost`: number or `null` (double); `usage.cost_details.upstream_inference_*`; `usage.is_byok`                                                                                                   | same (`ChatUsage`)                                             |
| Generation lookup `GET /generation?id=` returns `total_cost` "in USD" and `upstream_inference_cost`                                                                                                   | `api/api-reference/generations/get-request-&-usage-metadata-…` |
| Structured output: `response_format: { type: "json_schema", json_schema: { name, strict, schema } }`                                                                                                  | `guides/features/structured-outputs.md`                        |
| Structured-output support is **per endpoint**; set `provider.require_parameters: true` to route only to endpoints that support the request's parameters. `strict` enforcement varies by provider      | same                                                           |

## 2. Errors

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Source                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Error body `{ error: { code: number, message: string, metadata?: object } }`                                                                                                                                                                                                                                                                                                                                                                                         | `api_reference/errors-and-debugging.md` |
| HTTP: 400 bad request, 401 credentials, 402 insufficient credits, 403 forbidden/guardrail/moderation, 408 timeout, 429 rate limited, 502 model down/invalid response, 503 no eligible provider                                                                                                                                                                                                                                                                       | same                                    |
| **Once the provider accepts the request, the status is `200` even if generation fails**: non-streaming responses then carry an `error` object (with or without `choices`), `finish_reason: "error"`                                                                                                                                                                                                                                                                  | same, "Mid-stream errors"               |
| Typed `error.metadata.error_type`: `context_length_exceeded`, `max_tokens_exceeded`, `token_limit_exceeded`, `string_too_long`, `authentication`, `permission_denied`, `payment_required`, `rate_limit_exceeded`, `provider_overloaded`, `provider_unavailable`, `invalid_request`, `invalid_prompt`, `not_found`, `precondition_failed`, `payload_too_large`, `unprocessable`, `content_policy_violation`, `refusal`, image errors, `server`, `timeout`, `unmapped` | same, "Typed error codes"               |
| `Retry-After` on 429, 503, and on 402 whose `metadata.limit_source` is `openrouter_in_flight_budget` (transient)                                                                                                                                                                                                                                                                                                                                                     | same; `api_reference/limits.md`         |
| Budget blocks are 403 with `metadata.limit_source` ∈ `openrouter_guardrail_budget`, `openrouter_workspace_budget`, `openrouter_key_limit`                                                                                                                                                                                                                                                                                                                            | same                                    |
| Moderation metadata includes `flagged_input` (up to 100 characters **of the prompt**)                                                                                                                                                                                                                                                                                                                                                                                | same                                    |
| On 500, `message` is masked and `provider_code` omitted; `error_type` is still `server`                                                                                                                                                                                                                                                                                                                                                                              | same                                    |
| A reasoning model can return `200`, `finish_reason: "length"`, empty content, with the prompt still charged                                                                                                                                                                                                                                                                                                                                                          | same, "When no content is generated"    |

## 3. Limits

| Fact                                                                                                                         | Source                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Free variants (`:free`): 20 requests/minute; 50 requests/day with < 10 credits purchased, 1000/day with ≥ 10                 | `api_reference/limits.md` |
| `GET /key` reports `limit_remaining`, `usage*`, `is_free_tier`, `free_model_daily_requests`                                  | same                      |
| In-flight spending budget: 402 `in_flight_budget_exhausted` is transient (`Retry-After`); 402 `weight_exceeds_budget` is not | same                      |
| Successful inference responses carry no `X-RateLimit-*` headers                                                              | same                      |

## 4. Data policy

| Fact                                                                                                                                                                     | Source                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| OpenRouter does not store prompts/responses unless the account opts in (logging, or product-improvement use for a 1 % discount); both off by default. Metadata is stored | `guides/privacy/data-collection.md`                         |
| Inference traffic, including ZDR, is screened in flight for CSAM; flagged content may be retained                                                                        | same; `guides/features/zdr.md`                              |
| Each upstream provider has its own retention/training policy; per-request filter `provider.data_collection: "deny"` excludes providers that may train                    | `guides/privacy/provider-logging.md`; `ProviderPreferences` |
| `provider.zdr: true` restricts routing to Zero-Data-Retention endpoints (some models become unavailable)                                                                 | `guides/features/zdr.md`                                    |
| OpenRouter's own terms: `https://openrouter.ai/terms`; privacy policy: `https://openrouter.ai/privacy`                                                                   | `guides/privacy/data-collection.md`                         |

Commercial-use terms of individual **models** are set by each model author/provider and were
**not** reviewed here; they must be checked per model before production use (risk R5).

## 5. Pricing representation (catalog `GET /models`)

- `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write`,
  `pricing.internal_reasoning`, … are **strings, USD per token** (e.g. `"0.0000000416666666666667"`);
  `pricing.request` is USD per request.
- Some models carry `pricing.overrides[]` with a `min_prompt_tokens` condition (prompt-size price
  tiers), e.g. a higher price above 272 000 or 100 000 prompt tokens.
- Sentinels: `"-1"` = dynamic router (price unknown up front); `"0"` = free variant or preview.
- `supported_parameters` (e.g. `structured_outputs`, `response_format`, `seed`, `tools`) and
  `architecture.input_modalities` / `output_modalities`, `context_length`,
  `top_provider.max_completion_tokens`, `canonical_slug`, `expiration_date` are per model.

Catalog snapshot (2026-11-17, 282 text models with `structured_outputs` on
`/chat/completions`, paid only). Candidates proposed for the **development seed** only (§6.6), USD per
million tokens:

| Model `id`                     | `canonical_slug`                        | Input | Output | Context   | Notes                                                      |
| ------------------------------ | --------------------------------------- | ----: | -----: | --------- | ---------------------------------------------------------- |
| `deepseek/deepseek-v4-flash`   | `deepseek/deepseek-v4-flash-20260423`   | 0.072 |  0.144 | 1 048 576 | text only; `seed`, `response_format`, `structured_outputs` |
| `google/gemini-3.5-flash-lite` | `google/gemini-3.5-flash-lite-20260721` | 0.150 |  1.250 | 1 048 576 | multimodal input; cache read/write prices                  |
| `anthropic/claude-haiku-5.5`   | `anthropic/claude-haiku-5.5-20261007`   | 0.100 |  0.500 | 1 000 000 | prompt-size tier above 100 000 tokens; no `seed`           |

None of these has been benchmarked (AI_PROVIDER_STRATEGY §9). They are not production defaults.
