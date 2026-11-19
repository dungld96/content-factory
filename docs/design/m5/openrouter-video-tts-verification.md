# OpenRouter Video and TTS verification record (M5 design input)

- Retrieved: 2026-11-19 (UTC, catalogs at 05:2xZ) from the official documentation and the public,
  unauthenticated catalogs:
  - OpenAPI spec `https://openrouter.ai/docs/openapi/openapi.yaml` (operations `POST /videos`,
    `GET /videos/{jobId}`, `GET /videos/{jobId}/content`, `GET /videos/models`,
    `POST /audio/speech`, `GET /models`, `GET /generation`)
  - Guides `https://openrouter.ai/docs/guides/overview/multimodal/video-generation.md`,
    `…/multimodal/tts.md`; cookbooks `https://openrouter.ai/docs/cookbook/video-generation/*.md`
    (text-to-video, image-to-video, reference-to-video, webhooks, provider options)
  - OpenRouter's official agent skill
    `https://raw.githubusercontent.com/OpenRouterTeam/skills/main/skills/openrouter-video/SKILL.md`
  - Catalogs `GET https://openrouter.ai/api/v1/videos/models` (35 models) and
    `GET https://openrouter.ai/api/v1/models?output_modalities=speech` (39 models), snapshots in
    `evidence/`; model pages `https://openrouter.ai/<model>` for TTS price units.
- No API key was used and no paid call was made.
- Hosts of direct providers (ElevenLabs, fal, Replicate, Google AI Studio, OpenAI, BytePlus) are
  **not reachable** from this environment. Language support of TTS models was taken from web
  search results that quote the vendors' own documentation (marked "search"); it must be confirmed
  in the benchmark.
- Prices are registry data with an effective date, never constants in code (ADR-0012).

## 1. Video API

| Fact                                                                                                                                                                                                                                                                                                                  | Source                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Asynchronous.** `POST /api/v1/videos` returns `202` with `{ id, polling_url, status }`; `GET /api/v1/videos/{jobId}` returns the same object as it progresses                                                                                                                                                       | OpenAPI, guide                                                                          |
| Status enum: `pending`, `in_progress`, `completed`, `failed`, `cancelled`, `expired`. Terminal: the last four. `expired` = "Job exceeded maximum time to live"                                                                                                                                                        | OpenAPI, guide (webhooks)                                                               |
| Job id format `gen-vid-<timestamp>-<20 alphanumerics>`                                                                                                                                                                                                                                                                | OpenAPI (`id`)                                                                          |
| Request: `model` (required), `prompt` (required except image-only models), `duration` (s; `-1` only where listed), `resolution` (`360p`…`4K`), `aspect_ratio` (incl. `9:16`), `size` (`WxH`), `seed`, `generate_audio`, `frame_images`, `input_references`, `callback_url`, `provider`, `session_id`, `user`, `trace` | OpenAPI `VideoGenerationRequest`                                                        |
| Unsupported duration/resolution/aspect ratio → `400` that lists the supported values; validate client-side against the model record                                                                                                                                                                                   | text-to-video cookbook, skill                                                           |
| `frame_images[]`: `{ type: "image_url", image_url: { url }, frame_type: "first_frame" \| "last_frame" }`; with both `frame_images` and `input_references`, the request is image-to-video                                                                                                                              | OpenAPI, image-to-video cookbook                                                        |
| Image `url`: a public `https://` URL **or a base64 data URL** (`data:image/png;base64,…`)                                                                                                                                                                                                                             | official skill (the API reference shows only URLs; **confirm in the first paid smoke**) |
| `generate_audio`: defaults to the endpoint's flag; some providers default to audio, so send `false` for silent video; some models always include audio                                                                                                                                                                | OpenAPI                                                                                 |
| Completed response: `unsigned_urls[]` (need the API key), optional `urls[]` (signed, no key, until `expires_at`; treat as secrets), `usage: { cost (USD, number), is_byok }`, `generation_id`                                                                                                                         | OpenAPI, guide                                                                          |
| Download: `GET /api/v1/videos/{jobId}/content?index=0` streams the provider bytes (`video/mp4`)                                                                                                                                                                                                                       | OpenAPI                                                                                 |
| **No idempotency key** on `POST /videos` (no header or body field); no cancel endpoint; no list endpoint                                                                                                                                                                                                              | OpenAPI (operations listed above)                                                       |
| Polling: guide suggests ~30 s; "typically 30 seconds to several minutes"                                                                                                                                                                                                                                              | guide, best practices                                                                   |
| Webhooks: `callback_url` (HTTPS) or a workspace default; events `video.generation.{completed,failed,cancelled,expired}`; header `X-OpenRouter-Idempotency-Key: <job_id>-<status>`; optional HMAC `X-OpenRouter-Signature: t=…,v1=…` over `<ts>,<raw body>`                                                            | guide, webhooks cookbook, skill                                                         |
| **No Zero Data Retention for video**: "the provider must retain the generated video output briefly"; `zdr: true` fails routing. `data_collection: deny` excludes endpoints that train on data, not ones that retain prompts                                                                                           | guide, OpenAPI                                                                          |
| Billing of failed/expired jobs: **not documented** (the image guide's "all-or-nothing" statement has no video counterpart)                                                                                                                                                                                            | —                                                                                       |
| Errors: `400` (invalid parameters), `402` (insufficient credits); others as the general API                                                                                                                                                                                                                           | OpenAPI                                                                                 |

### 1.1 Model records (`GET /api/v1/videos/models`)

Fields: `supported_durations` (discrete list, e.g. `[4, 6, 8]`), `supported_resolutions`,
`supported_aspect_ratios`, `supported_sizes`, `supported_frame_images`, `generate_audio`, `seed`,
`allowed_passthrough_parameters`, `pricing_skus` (string map, provider prefix stripped).

`pricing_skus` naming is **not uniform**. Patterns seen in the 35 records:

| Pattern                                                                                    | Unit                    | Examples                                   |
| ------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------ |
| `duration_seconds[_with_audio\|_without_audio][_<res>]`                                    | USD per output second   | Veo 3.1, Wan 3.0, Kling, Hailuo            |
| `text_to_video_…` / `image_to_video_duration_seconds_<res>`                                | USD per output second   | Wan 2.6, Kling                             |
| `cents_per_second_output[_<res>]`, `cents_per_video_output_second_<res>`                   | **US cents** per second | FLUX video, Runway, Grok Imagine           |
| `cents_per_image_input`, `reference_input_images`, `reference_images`                      | per input image         | Grok Imagine, HeyGen, Hailuo 3             |
| `video_tokens[_<res>][_with_video_input\|_without_audio]`                                  | USD per video token     | Seedance (no per-second estimate possible) |
| `long_…`, `reference_duration_seconds_…`, `minimum_cents_per_generation`, `…continuation…` | special cases           | HeyGen, Runway                             |

### 1.2 Candidates for 9:16 image-to-video (first frame), prices at retrieval

| Model                              | Durations (s) | Resolutions       | First frame | Seed | Relevant price (no audio)              | 30 s at 720p\* |
| ---------------------------------- | ------------- | ----------------- | :---------: | :--: | -------------------------------------- | -------------: |
| `google/veo-3.1-lite`              | 4, 6, 8       | 720p, 1080p       |      ✓      |  ✓   | 0.03 $/s (720p), 0.05 $/s (1080p)      |          $0.90 |
| `alibaba/wan-3.0`                  | 2–30          | 480p, 720p, 1080p |      ✓      |  ✓   | 0.05 / 0.10 / 0.20 $/s                 |          $3.00 |
| `kwaivgi/kling-v3.0-std`           | 3–15          | 720p              |      ✓      |  —   | 0.084 $/s                              |          $2.52 |
| `x-ai/grok-imagine-video-1.5-lite` | 1–15          | 480p–1080p        |      ✓      |  —   | 3 ¢/s (720p) + 1 ¢ per input image     |          $0.95 |
| `heygen/heygen-video-1`            | 5–30          | 480p–2K           |      ✓      |  ✓   | 0.036 $/s (768p)                       |   $1.08 (768p) |
| `bytedance/seedance-2.0-mini`      | 4–15          | 480p, 720p        |      ✓      |  ✓   | per video token → **estimate unknown** |              ? |

\* 5 scenes × 6 s, one clip each, `generate_audio: false`. Final cost is the provider-reported
`usage.cost`.

## 2. TTS API

| Fact                                                                                                                                                                                                                                                                                         | Source                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Synchronous.** `POST /api/v1/audio/speech` returns the raw audio stream; OpenAI Audio Speech compatible                                                                                                                                                                                    | OpenAPI, TTS guide                              |
| Request: `model`, `input` (string, or turns for multi-speaker models), `voice` (model-specific; required by most), `response_format` (`mp3` \| `pcm`, default `pcm`), `speed`, `instructions` (some models), `input_references` (voice cloning), `provider` (incl. `zdr`, `data_collection`) | OpenAPI `SpeechRequest`, guide                  |
| `pcm` = 16-bit little-endian; Gemini TTS and HeyGen return **pcm only** (`mp3` → 400)                                                                                                                                                                                                        | OpenAPI, guide                                  |
| Response header `X-Generation-Id`; usage and cost via `GET /api/v1/generation?id=…`                                                                                                                                                                                                          | guide, OpenAPI                                  |
| Voices per model: `supported_voices` in the speech catalog                                                                                                                                                                                                                                   | guide, catalog                                  |
| Price unit for character-priced models: `pricing.prompt` is **USD per character** (e.g. Eleven Turbo v2.5 "$40 per M characters", `prompt: 0.00004`)                                                                                                                                         | model page + catalog                            |
| Gemini TTS models are priced per token (`prompt`, `completion`) → no per-character estimate                                                                                                                                                                                                  | catalog                                         |
| ZDR is available for TTS: 30 of 39 speech models list ZDR endpoints, incl. all ElevenLabs and Microsoft MAI models                                                                                                                                                                           | `GET /models?output_modalities=speech&zdr=true` |

### 2.1 Candidates (Vietnamese and English)

| Model                          | $/M chars | ZDR | Vietnamese                                                      | Request limit |
| ------------------------------ | --------: | :-: | --------------------------------------------------------------- | ------------- |
| `elevenlabs/eleven-flash-v2.5` |        40 |  ✓  | yes, 32 languages incl. Vietnamese (search: ElevenLabs help)    | 40,000 chars  |
| `elevenlabs/eleven-v4`         |        80 |  ✓  | 90+ languages (catalog description); Vietnamese to confirm      | 10,000 chars  |
| `microsoft/mai-voice-2.1`      |        22 |  ✓  | native voices `vi-VN-Grant`, `vi-VN-Harper` (catalog)           | —             |
| `google/gemini-3.8-flash-tts`  |  (tokens) |  ✓  | `vi-VN` GA for Gemini-TTS (search: Google Cloud docs); pcm only | —             |

ElevenLabs voices on OpenRouter are the premade multilingual set (`george`, `sarah`, `adam`, …).
A 30-second script (~450 characters) costs about $0.01–0.04 with these models.

## 3. Consequences for the design

1. One integration (OpenRouter) covers video and TTS; the M2/M4 key, data-policy flags and
   ledger apply. Direct adapters remain possible behind the same interfaces.
2. Video submit is **not idempotent** and **cannot be cancelled**: a lost submit response must not
   be retried automatically (double charge), and cancelling our job does not stop provider
   billing.
3. Persist the provider job id **before** waiting; resume after a restart by polling, never by
   submitting again.
4. Price import must parse several SKU naming schemes, convert cents, and treat token-priced or
   unrecognised SKUs as **unknown** (explicit confirmation, ADR-0012).
5. Durations are discrete per model; a scene's duration must map to a supported value.
6. Video cannot use ZDR: the owner must accept provider retention of keyframes (character
   likeness) before enabling a video model. TTS can require ZDR.
7. Keyframes can be sent as data URLs (to confirm in the paid smoke), so storage stays private.
