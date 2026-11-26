# MixRoute verification record (P5)

- Retrieved: 2026-11-26, from the official site and documentation (pages listed in §9).
- Purpose: CLAUDE.md §6. What the P5a adapters (text, Seedream image) rely on, and what is still
  unverified for P5b (video) and later (TTS, Veo).
- No live call was made: there is no MixRoute key in this environment. Fixtures in
  `packages/ai-core/src/mixroute/contract.test.ts` are derived from the documented shapes below.
  The first paid smoke run must record real responses (risk R1 in the package).

## 1. Gateway

- AI API gateway run by ELITE CLOUD PTE. LTD. (Singapore); "250+ models" from OpenAI, Anthropic,
  Google, DeepSeek, xAI and others (the models page showed 285 models, 16 providers).
- Base URL `https://api.mixroute.ai/v1`. Auth `Authorization: Bearer <key>`; keys are shown as
  `sk-xxxxxxxxxx` (placeholder; the exact format is not documented, so the env check accepts
  `sk-` + 16 or more URL-safe characters).
- "Based on the unified OpenAI API standard"; the official OpenAI SDK works with the base URL.
  OpenRouter compatibility is **not** claimed: no `provider` routing object, no `GET /key`, no
  `usage.cost`.
- Pricing claim: "0% markup", provider prices passed through. Marketing figures (P50 overhead,
  uptime) have no methodology and are not relied on.
- Compliance: SOC 2 / ISO 27001 "audit in progress, expected Q1 2027".

## 2. Text: `POST /chat/completions`

- Request fields documented: `model`, `messages`, `max_tokens`, `temperature` (0–2), `top_p`
  (0–1), `seed`, `stop` (string or array), `response_format` (`text`, `json_object`,
  `json_schema` with `{ name, schema }`), `stream`, `n`, penalties, `logit_bias`, `user`,
  `tools`, `tool_choice`.
- Response: `id`, `object`, `created`, `model`, `choices[]` (`message.content`,
  `finish_reason`), `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`). **No cost
  field and no request-id header are documented.** Only `finish_reason: "stop"` appears in the
  examples; the adapter also maps `length` and `content_filter` (OpenAI semantics).
- Model pages list structured output (`response_format: json_schema`) as available for
  `claude-haiku-5-5`, `gemini-3.5-flash-lite`, `gemini-3.5-flash`, `deepseek-v4-flash`.
- Not used: the Anthropic Messages (`/v1/messages`) and Gemini native routes. They document no
  structured-output field.

## 3. Image: Seedream 5.5 on `POST /images/generations`

- Model `doubao-seedream-5-5-261028`. One endpoint for generation, editing and decomposition;
  top-level JSON fields (no `metadata` wrapper); the docs say not to use `/images/edits`.
- `prompt` required. `image`: a URL or base64 data URL, or an array. Generation takes **up to 10**
  references; each at most 30 MB, aspect ratio 1:16 to 16:1.
- `size`: `1K`, `1.5K`, `2K` (default) or `WIDTHxHEIGHT` with **921,600 to 4,624,220 total
  pixels**. There is **no aspect-ratio field** (presets take the ratio from the prompt), so the
  adapter always sends an explicit size.
- `output_format` `png` (default) or `jpeg`; `response_format` `url` (default; URLs valid 24 h)
  or `b64_json`; `watermark` defaults to **true** (the adapter sends `false`); `background`;
  `safety_identifier`; `layer_decomposition*`.
- Not supported: `seed`, streaming; "`n` does not control the output count".
- Response: `data[]` with `b64_json` or `url`, `size`, `output_format`; top-level `usage` with
  `input_images` and `generated_images`. **No cost in the response.**
- Price (model page and `seedream.md`, USD per image): input image **0.0075**; output ≤ 2,610,000
  px **0.0195**, above it **0.0345**. "Unsuccessful outputs are not charged." Whether a call that
  times out on the client is charged is not documented (recorded as `outcome_unknown`).

## 4. Models and key check: `GET /models`

- Returns `{ object: "list", data: [{ id, object, created, owned_by }] }`; the list depends on the
  key's permissions; caching for 1 h is recommended. **No prices, limits or parameters.**
- `401` = "API Key invalid or expired". The adapter's free key check calls this endpoint.

## 5. Errors

- Body: `{ "error": { "message", "type", "code" } }` (example `invalid_api_key`).
- Status table (`faq/error-code`): 400 parameters; 401 invalid token; **403 "Token Group
  Disabled" (usually the token's quota is used up)**; 404 endpoint; 429 traffic limit (TPM);
  500 internal; 503 "Model Unavailable"; 504 gateway timeout. No `Retry-After` is documented
  (the adapter still honours one).
- Mapping in `packages/ai-core/src/mixroute/errors.ts`: 403 → `PROVIDER_BUDGET_EXCEEDED` (never
  retried), 503 → `PROVIDER_UNAVAILABLE`, 504 → `TIMEOUT`, others as for OpenRouter.

## 6. Limits, data and terms

- Rate limits: new accounts **50 RPM**, 100 RPM after the first top-up; business plans up to
  6,000 RPM on request. No rate-limit headers documented.
- Data (`faq/data-security`): TLS 1.3; "No saving of API request inputs/outputs"; logs keep
  timestamps, token counts, model, status; "all system logs are kept for only 7 days". "Each
  upstream provider applies its own data policy." **No per-request zero-data-retention or
  no-training routing option exists**, unlike OpenRouter's `data_collection: deny` / `zdr`.
- Free tier: "$5 credit" for new accounts; some models in a free group. Per CLAUDE.md §2.14 this is
  never production capacity.
- Cost reconciliation: `GET https://console.mixroute.ai/api/log/self` (needs a separate system
  access token and `New-Api-User` header) lists calls with `request_id` and `quota`
  (1 USD = 500,000 quota). No filter by request id; logs kept 7 days. Out of scope in P5a.

## 7. Curated catalog (prices read 2026-11-26)

USD per 1M tokens unless noted. Source: `https://mixroute.ai/models/<slug>/`.

| Model id                     | Input                | Output                     | Cached | Notes                                                                                     |
| ---------------------------- | -------------------- | -------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `claude-haiku-5-5`           | 0.10                 | 0.50                       | 0.01   | cache write 0.125 (1 h: 0.20); input > 100K: 0.50 / 2.50 / 0.05 / 0.625; ctx 1M, out 128K |
| `gemini-3.5-flash-lite`      | 0.30                 | 1.20                       | 0.03   | ctx 1,048,576, out 65,536; the page FAQ says "pricing varies by tier" (listing is flat)   |
| `gemini-3.5-flash`           | 1.50                 | 9.00                       | 0.15   | ctx 1,048,576, out 65,536                                                                 |
| `deepseek-v4-flash`          | 0.14                 | 0.28                       | 0.0028 | ctx 1M, out 384K, text only                                                               |
| `doubao-seedream-5-5-261028` | 0.0075 / input image | 0.0195 / image (≤ 2.61 MP) | —      | 0.0345 / image above 2.61 MP                                                              |

Seedream 5.0 Flash (the OpenRouter route) was not found on MixRoute.

## 8. Not verified (blocks later slices)

- Video: Seedance contract read (`/video/generations`, `metadata.content[]` with frame roles,
  `duration`, `resolution`, `ratio`, status values, result URL locations per route); **Veo, Kling,
  Wan, MiniMax layouts not read**; output URL expiry not documented. → P5b.
- TTS: `POST /audio/speech` takes `model`, `input`, `voice`, `response_format`; voices, formats
  and price units not documented on the endpoint page. → later slice.
- Response headers (request id, rate limits): not documented; check on the first live call.

## 9. Pages read

- https://mixroute.ai/ · https://mixroute.ai/pricing/ · https://mixroute.ai/models/ ·
  https://mixroute.ai/ratelimits/
- https://mixroute.ai/docs/introduction · https://mixroute.ai/docs/llms.txt ·
  https://mixroute.ai/docs/api-reference/models
- Endpoints: `chat-openai.md`, `list-models.md`, `image-generation.md`, `seedream.md`,
  `submit-video-task.md`, `query-video-task.md`, `download-video.md`, `seedance.md`,
  `audio-speech.md`, `user-logs.md`, `gemini-native.md`, `messages.md` (under
  https://mixroute.ai/docs/api-reference/endpoint/)
- FAQ: `faq/error-code.md`, `faq/data-security.md`
- Model pages: `claude-haiku-5-5`, `gemini-3-5-flash-lite`, `gemini-3-5-flash`,
  `deepseek-v4-flash`, `doubao-seedream-5-5-261028`, `dola-seedream-5-5`

## 3b. Gemini image models (added 2026-11-26)

- Docs (`nano-banana.md`, model page `gemini-2-5-flash-image`): Gemini native
  `POST …/models/{model}:generateContent`; body `contents[].parts[]` (text, `inlineData`
  references) and `generationConfig.responseModalities: ["TEXT","IMAGE"]`,
  `generationConfig.imageConfig.aspectRatio`; no `imageSize` for 2.5 (about 1K output); image
  back in `candidates[].content.parts[].inlineData` (skip `thought` parts); `usageMetadata`
  token counts; no cost field. Price: $0.30/1M input, $30/1M output, "each image is billed at
  0.039 USD". Reference-image limits, `9:16` support for 2.5, seed and candidate count are not
  documented.
- **Live checks (development key):**
  - Both `/v1beta/models/…` and `/v1/models/…` exist: an empty body answers at once with
    `HTTP 500 {"error":{"code":"invalid_request","message":"contents is required …"}}`. The
    adapter uses `/v1beta` and maps `invalid_request` to `INVALID_REQUEST` (never retried).
  - An unknown model answers `HTTP 503 model_not_found` "No available channel for model … under
    group free (distributor)": **the key is in MixRoute's `free` group**, which explains its
    15-model list (CLAUDE.md §2.14: never production capacity).
  - Two real 9:16 generations (`/v1beta`, then `/v1`) **returned nothing for 10 and 3 minutes**
    and were stopped. Whether they were charged is unknown; check the MixRoute dashboard. 9:16
    output for 2.5 is therefore still unverified.
