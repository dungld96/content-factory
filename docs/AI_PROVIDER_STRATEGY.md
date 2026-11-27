# AI Provider Strategy

How the platform uses AI models without locking into one vendor. Code: `packages/ai-core`
(interfaces, adapters, mocks) and `packages/ai-runtime` (services, ledger).

## 1. Principles

- Business logic depends on capability interfaces, never on a vendor SDK. ESLint allows the
  vendor adapters only in `packages/ai-runtime/src/providers` (and test doubles only in tests).
- A provider supports only the capabilities it declares. Chat support does not imply image,
  video or TTS support; OpenAI-compatible does not mean the same behaviour.
- A model is used only if it supports the requested capability and parameters.
- No model becomes a production route without a benchmark and a terms review.
- Free tiers are never relied on; "free" is not claimed unless the provider's current terms say so.

## 2. Capability interfaces

| Interface | Call style | Notes |
|---|---|---|
| `LlmProvider` | Synchronous | Structured JSON output; one repair call on invalid output |
| `ImageProvider` | Synchronous | Prompt, aspect ratio, resolution tier, count, seed, reference images |
| `VideoProvider` | **Asynchronous**: `submit` → `poll` → `download` | Submit is paid and has no idempotency key: a lost response is outcome `unknown` and never resubmitted automatically |
| `TtsProvider` | Synchronous | MP3 by default; PCM-only models are wrapped as WAV |

Capabilities in the registry: `llm`, `image_generation`, `image_edit`, `video_generation`, `tts`,
`transcription`, `vision_evaluation` (the last three are not used yet).

Each interface has a typed request and result. There is no universal `generate()` method.
Every adapter validates input, normalizes responses and errors into `ProviderError`, exposes
the provider job ID for async work, reports usage and cost when the provider gives it, redacts
secrets, and carries the correlation ID.

Mocks for tests and local use: `MockLlmProvider`, `MockImageProvider`, `MockVideoProvider`
(renders a real MP4), `MockTtsProvider`; seeded as the free models `mock/echo`,
`mock/solid-image`, `mock/still-video`, `mock/tone-tts`.

## 3. Current providers: OpenRouter, MixRoute

**MixRoute (P5, ADR-0023)** is a second gateway for text and Seedream images (P5a; video and TTS
later). It is OpenAI-compatible, reports **no per-call cost** (calls are recorded at the registry
estimate) and has **no zero-data-retention routing** (ZDR routes cannot move to it). Its models
and prices come from a curated catalog (`apps/api/src/ai/providers/mixroute-catalog.ts`;
verification record `docs/design/p5/mixroute-verification.md`). Settings › AI › Switch gateway
moves every task to one gateway in one audited step; there is still no automatic fallback.

OpenRouter is the gateway in production use. It was verified against official documentation before each
adapter was written (records in `docs/design/m2/`, `m4/`, `m5/`).

| Capability | Endpoint | Data policy |
|---|---|---|
| LLM | Chat completions | `data_collection: "deny"`, `require_parameters: true`, same-model host fallback only; ZDR per call |
| Image | `POST /api/v1/images` (base64 output, all-or-nothing billing) | `data_collection: "deny"`; ZDR per route |
| Video | `POST /videos` (frames as base64 data URLs) | `data_collection: "deny"`; **no ZDR exists for video** |
| TTS | `POST /audio/speech`; cost from `GET /generation?id=` | `data_collection: "deny"`, `zdr: true` |

Routes measured in the M8 pilot (`docs/design/m8/pilot-report.md`, `docs/design/m5/benchmark-results.md`):

| Task | Model |
|---|---|
| Script | Gemini 3.5 Flash Lite |
| Storyboard | Claude Haiku 5.5 (Gemini did not keep to the clip lengths) |
| Keyframe images | Seedream 5.0 Flash |
| Clips | Veo 3.1 Lite |
| Voice-over | Per voice profile (e.g. MAI-Voice 2.1 for Vietnamese) |

## 4. Model registry

Stored in PostgreSQL. Platform operators (`OPERATOR_EMAILS`) change provider and model status,
schema mode and task routes in **Settings → AI providers & models** (or with `pnpm ai:registry`);
prices and catalog imports stay CLI-only. Every change is audited in `ai_registry_events`. API keys
stay in the server environment; Settings shows whether a key is configured and can test it for
free (`GET /key`). Each model records:

- provider, model key, capabilities, modalities, supported parameters;
- limits: context/output size, image limits (`image_constraints`), video/TTS limits
  (`media_constraints`: durations, resolutions, aspect ratios, frame inputs, audio, voices);
- `schema_mode` (`full`, or `basic` for models that reject strict JSON schemas);
- quality tier, status (new models start **disabled**), free-variant flag, rate-limit and
  data-policy notes, benchmark score;
- append-only prices with metric, unit price, source, URL and effective date
  (`docs/COST_STRATEGY.md`).

Import commands read OpenRouter's public catalog and create models disabled; prices can change
without a deploy.

## 5. Routing

Each generation task (`script_generation`, `storyboard_generation`, `image_generation`,
`video_generation`, TTS via the voice profile) has one routed model in `ai_task_routes`. A
request may name another enabled model. Candidates are filtered by:

1. provider and model enabled;
2. capability supported;
3. requested parameters within the model's recorded limits;
4. budget available (`docs/COST_STRATEGY.md`);
5. provider circuit not open.

The estimate (or "unknown") is returned before paid work.

## 6. Errors, retry and fallback

Retry (same model) for: network errors, provider 5xx, rate limits within `Retry-After`.

Never retry or fall back for: invalid request, unsupported parameter, content-policy rejection,
authentication failure, budget block, or a user rejecting the output.

There is **no automatic fallback to another model**: it could change quality or drop required
features. When a provider keeps failing, its circuit opens and work waits (up to 2 h), then fails.

## 7. Adding a provider or model

1. Read the official docs: model IDs, parameters, pricing units, rate limits, async lifecycle,
   data retention and training terms. Write a verification record in `docs/design/`.
2. Implement the adapter behind the capability interface, with request/response normalization.
3. Add fixture-based contract tests and a mock. No paid calls in CI.
4. Import the model (disabled), run the paid smoke test (`ACF_PAID_SMOKE=1`, capped).
5. Benchmark: same prompts and inputs for every candidate, about 10 samples each; score prompt
   adherence, consistency, visual and motion quality, latency, failure rate and cost. Save
   outputs and scores. Never choose from marketing examples.
6. Enable and route it.

## 8. Data governance

Before sending a character master, unreleased product or other private asset to a provider,
check its retention and training terms and commercial-use rights. Video providers keep prompts
and keyframes (no ZDR option); this is listed in `docs/KNOWN_LIMITATIONS.md`.
