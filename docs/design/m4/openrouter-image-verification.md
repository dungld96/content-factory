# OpenRouter Image API verification record (M4 design input)

- Retrieved: 2026-11-18 (UTC, catalog at 13:46Z) from the official documentation
  (`https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md`,
  `https://openrouter.ai/docs/client-sdks/typescript/sdks/images/README.md`, index
  `https://openrouter.ai/docs/llms.txt`) and the public, unauthenticated catalog
  (`GET https://openrouter.ai/api/v1/images/models`, `GET …/images/models/{id}/endpoints`).
- No API key was used and no paid call was made.
- Official documentation of OpenAI, Google (Gemini/Imagen), Black Forest Labs, fal and Replicate
  is **not reachable** from the build environment (hosts outside the network allow-list), so
  direct adapters could not be verified for M4. Third-party price summaries found by web search
  are not used as facts.
- Facts are as of the retrieval date. Prices are registry data with an effective date, never
  constants in code (ADR-0012).

## 1. API surface

| Fact                                                                                                                                                                                                                                                                                                                                                | Source                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Dedicated endpoint `POST /api/v1/images` with `model` and `prompt` (required)                                                                                                                                                                                                                                                                       | image-generation guide, "API Usage"    |
| Response `{ created, data: [{ b64_json, media_type? }], usage: { prompt_tokens, completion_tokens, total_tokens, cost } }`; images are **base64 in the response body** (no URL, no provider job to poll)                                                                                                                                            | guide, "Response Format"               |
| `media_type` present whenever identifiable (`image/png`, `image/jpeg`, `image/webp`, `image/svg+xml`); omitted otherwise                                                                                                                                                                                                                            | same                                   |
| Optional: `n` (1–10, providers may return fewer; single-image providers reject `n > 1`), `resolution` (`512`, `768`, `1K`, `1.5K`, `2K`, `4K`), `aspect_ratio` (incl. `9:16`, `1:1`, `16:9`; providers clamp to their subset), `size`, `quality`, `output_format`, `background`, `output_compression`, `seed`, `stream`, `input_references`, `user` | guide, "Request Parameters"            |
| `input_references`: `[{ type: "image_url", image_url: { url } }]`; URL may be HTTP(S) **or a base64 data URL**; the accepted count varies by provider                                                                                                                                                                                               | guide, "Image-to-Image"                |
| Routing: `provider.only/order/ignore/sort/allow_fallbacks`, `provider.zdr` (only Zero-Data-Retention endpoints), `provider.data_collection` (`allow` default, `deny` = only endpoints that do not train on the data; they may still retain prompts)                                                                                                 | guide, "Provider Routing"              |
| Discovery: `GET /api/v1/images/models` lists models with `architecture.input_modalities`, `supported_parameters` (typed descriptors: `enum`, `range`, `boolean`; absent = unsupported), `supports_streaming`                                                                                                                                        | guide, "Model Discovery"               |
| Per-endpoint records: definitive `supported_parameters`, `allowed_passthrough_parameters`, `pricing[]` with `billable` (`output_image`, `input_image`, `input_reference`, …), `unit` (`image`, `megapixel`, `token`, also `request` seen in the catalog), `cost_usd`, optional `variant` tier (e.g. `1k`, `2k`, `high_resolution`)                  | guide, "Per-Endpoint Records"; catalog |
| SDK error statuses: 400, 401, 402, 403, 404, 413, 429, 500, 502, 524, 529                                                                                                                                                                                                                                                                           | TypeScript SDK `images` README         |
| **Billing is all-or-nothing**: a failed or cancelled generation returns `502` and is not billed; a client disconnect is never billed to the user                                                                                                                                                                                                    | guide, "Billing and Cancellation"      |
| Example timing: `openai/gpt-image-2`, high quality, 1536×864 took 94 s                                                                                                                                                                                                                                                                              | guide, header example                  |

Not stated in the pages read, to be fixed by recorded fixtures in slice M4b: the error body of
the Image API (assumed to match the chat API's `{ error: { code, message, metadata } }`), a
request/generation id header, and `Retry-After` behaviour.

## 2. Catalog snapshot (2026-11-18)

70 image models. Shortlist: models whose endpoints accept `aspect_ratio: "9:16"` and
`input_references` (needed for character/environment consistency), priced per image, cheapest
first. Token-priced models (Google, OpenAI, Microsoft, MiniMax) have no fixed per-image price:
their cost is known only from `usage.cost` after a call.

| Model                                  | Endpoint                        | Price (output)                                                                   | `n` max | References max | Resolution tiers          | Seed |
| -------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------- | ------- | -------------- | ------------------------- | ---- |
| `black-forest-labs/flux-3-image-klein` | black-forest-labs               | $0.008 (768) · $0.009 (1K) · $0.011 (1.5K) · $0.014 (2K) · $0.036 (4K) per image | 1       | 10             | 768–4K                    | yes  |
| `bytedance-seed/seedream-5-0-flash`    | seed                            | $0.018 per image; input image $0                                                 | 1       | 14             | 1K, 1.5K, 2K              | yes  |
| `qwen/qwen-image-2.1-turbo`            | alibaba                         | $0.0184 per image (1K and 2K); input image $0                                    | 6       | 10             | 1K, 2K                    | yes  |
| `bytedance-seed/seedream-5-5`          | seed                            | $0.02 per image ($0.035 high resolution); input image $0.008                     | 1       | 10             | 1K, 1.5K, 2K              | yes  |
| `google/gemini-3.1-flash-image`        | google-ai-studio, google-vertex | $0.00006 per output image token (no fixed per-image price)                       | 1       | 14             | 512–4K                    | no   |
| `openai/gpt-image-2`                   | openai                          | $0.00003 per output image token, $0.000008 per input image token                 | 10      | 16             | none (`quality` low–high) | no   |

The full catalog and endpoint records are re-imported by the registry CLI (slice M4b); this table
is the design-time snapshot only.

## 3. Consequences for the adapter

- The call is **synchronous** and can run for minutes: the worker holds the request (timeout
  set above the longest observed generation, BullMQ lock longer than that timeout). There is no
  provider job id to persist; the invocation records the generation id if the response carries one.
- All-or-nothing billing makes a retry after a failed call cost-safe; a timeout is still
  recorded as `outcome_unknown` (M2 rule) because the client cannot see the outcome.
- Every request sends `provider.data_collection: "deny"` and `provider.allow_fallbacks: false`
  with `provider.only` set to the routed endpoint (same rule as the M2 text adapter:
  no silent switch to another model or host). `provider.zdr` is set when the route requires it.
- Reference images are sent as base64 data URLs: object storage stays private.
- `media_type` and the decoded bytes are both checked; a missing or disagreeing type fails the
  job (`OUTPUT_INVALID`).
- Prices need new registry metrics (per image, per megapixel, per image token) and a `variant`
  tier (design package §6).
