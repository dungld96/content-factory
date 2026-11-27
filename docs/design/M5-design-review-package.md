# M5 Design Review Package — Video and Audio Generation

- Status: **Revision 1, approved by the owner (2026-11-19)**: V1–V12 as proposed, data-governance
  risk R1 acknowledged. Implemented in slices M5a–M5e (§14).
- Date: 2026-11-19
- Baseline: M4 approved, M4.5 approved (`0d67d7d`); ADR-0006 (object storage), ADR-0012 (AI
  ledger), ADR-0013 (jobs), ADR-0015 (masters and variants), ADR-0016 (scene images, keyframes)
- Inputs: `docs/design/m5/openrouter-video-tts-verification.md` (provider facts, catalog
  snapshots in `docs/design/m5/evidence/`), IMPLEMENTATION_PLAN §M5, CONTENT_PIPELINE stages 7–8,
  COST_STRATEGY §4, AI_PROVIDER_STRATEGY §6–§10, API_SPEC §6

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                              | Section    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| V1  | Video provider: **OpenRouter Video API** (async submit → poll), a third adapter in the existing OpenRouter integration. Polling only in M5; webhooks later (need a public HTTPS receiver)                                                           | §3         |
| V2  | TTS provider: **OpenRouter `/audio/speech`** (sync), with **ZDR required** on TTS routes                                                                                                                                                            | §4         |
| V3  | Async lifecycle: persist the provider job id before waiting; **never resubmit automatically** once a submit may have reached the provider; resume by polling                                                                                        | §5         |
| V4  | One video job per scene, **first frame = the approved keyframe**; 1 clip per scene by default (max 2); 720p default (1080p optional); `generate_audio: false` by default                                                                            | §6         |
| V5  | Clip duration = the **smallest supported duration ≥ the scene's duration** (billed on that); M6 trims. Scenes longer than the model's maximum are flagged, not split                                                                                | §6.2       |
| V6  | **Clip approval** = a selection pointer per scene (`scene_clips`, like keyframes); identical scene + same keyframe in a newer storyboard version **reuses** the clip; **gate 4**                                                                    | §6.4       |
| V7  | Voice-over **per scene** (the scene's `voiceOverSegment`), from a project **voice profile** (model, voice, language, speed, instructions); approved per scene (`scene_voiceovers`)                                                                  | §7         |
| V8  | **Audio import**: upload MP3/WAV/M4A (≤ 25 MB) as a scene voice-over replacement or as a music track (licence note required); music selection and mixing stay in M6                                                                                 | §7.3       |
| V9  | **FFmpeg/FFprobe** (Debian bookworm package) in the deploy image and CI; every video and audio file is validated with FFprobe (no shell, argument arrays)                                                                                           | §8         |
| V10 | Prices as registry data: new metrics `output_video_seconds` (variants: resolution, audio) and `input_characters`; cents converted; token-priced or unknown SKUs → **unknown estimate**                                                              | §9         |
| V11 | Until M7 budgets: a **per-request spend guard** (`VIDEO_MAX_ESTIMATED_USD_PER_REQUEST`, default 5) plus explicit confirmation of every video estimate in the UI                                                                                     | §9.2       |
| V12 | Benchmark before routing: video `google/veo-3.1-lite`, `alibaba/wan-3.0`, `kwaivgi/kling-v3.0-std` (cap **USD 15**); TTS `elevenlabs/eleven-flash-v2.5`, `elevenlabs/eleven-v4`, `microsoft/mai-voice-2.1` (cap **USD 2**). All seeded **disabled** | §3.3, §4.2 |

Also requested: acknowledge the **data-governance risk** in §10 — no video endpoint offers zero
data retention, so keyframes (character likeness) are retained by the video provider per its
terms.

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M5):** video provider adapter; async submission and polling;
TTS adapter and audio import; scene-level retries; usage and cost records. Plus what they need:
FFprobe validation, HTTP Range streaming for playback, clip and voice-over review UI.

**Out of scope:** rendering, concatenation, subtitles, music mixing, final MP4 (M6); budgets,
circuit breakers, DLQ dashboards (M7; M5 keeps the M3 retry/DLQ rules and adds a spend guard);
webhooks (later, V1); video upload/import of user clips; lip-sync and avatar models; voice
cloning (the API supports it; not requested, adds consent questions); vision evaluation.

**Acceptance (IMPLEMENTATION_PLAN §M5) and evidence:**

| Criterion                                                                                     | Evidence                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video job completes or returns a clear actionable error                                       | Worker integration tests (mock provider: completed, failed, expired, timeout, 400, 402, ambiguous submit) + the error table in §5.4 shown in the UI; manual paid smoke with the routed model |
| Worker restart does not lose provider job tracking                                            | Integration test: worker stopped after submit; the reconciler resumes **polling** the same provider job; the mock counts exactly **one** submission                                          |
| Retry does not duplicate completed scenes                                                     | Integration + E2E: "generate all" with some scenes done submits only the others (execution-key reuse); a failed scene's retry submits only that scene                                        |
| (From CONTENT_PIPELINE 7) download, validate, store provider id and usage; user approves clip | Worker test on real SeaweedFS: object exists, FFprobe metadata on the asset, `provider_job_id` and cost on the job/invocation; E2E approves clips → gate 4                                   |

## 2. Where it sits

```text
approved storyboard (gate 2) ─ scenes 1..n
   ├─ approved keyframe per scene (gate 3, M4)
   │     └─ video job per scene ─ submit ─▶ poll … ─▶ download ─▶ clip assets ─▶ approved clip
   └─ voiceOverSegment per scene
         └─ TTS job per scene (voice profile) ─▶ audio asset ─▶ approved voice-over
gate 4 "media complete" = every scene has an approved clip, and every scene with voice-over text
has an approved voice-over (generated or imported) ──▶ M6 render
```

R1 stage descriptors (`packages/content-domain/src/formats.ts`) gain two `unit`-scoped stages for
`short_video`: `clips` (requires gate 3) and `voiceover` (requires gate 2, so audio can run in
parallel with images), and the gate `media_complete`.

## 3. Video provider

### 3.1 Interface (`packages/ai-core`, `media.ts`)

`VideoProvider` replaces today's placeholder type. It is two-phase because the provider is:

```ts
interface VideoProvider extends MediaProviderBase<'video_generation'> {
  submit(req: VideoRequest, ctx: CallContext): Promise<VideoSubmission>; // provider job id + status
  poll(providerJobId: string, ctx: CallContext): Promise<VideoJobState>; // status, cost, outputs
  download(providerJobId: string, index: number, ctx: CallContext): Promise<ReadableStream>;
}
```

`VideoRequest`: prompt, duration (s), resolution, aspect ratio, `generateAudio`, seed?,
`firstFrame` (image bytes + MIME). `VideoJobState`: `pending | running | completed | failed |
cancelled | expired`, provider error text, reported cost (exact decimal), output count, expiry.
`videoConstraintIssues` checks a request against the model's recorded limits
(`ai_models.video_constraints`: durations, resolutions, aspect ratios, frame types, audio, seed).
`MockVideoProvider` is async too: it completes after N polls and produces a real MP4 with FFmpeg
from the first frame (so E2E plays real files). It counts submissions for the restart test.

### 3.2 OpenRouter adapter (V1)

`POST /api/v1/videos` with `model`, `prompt`, `duration`, `resolution`, `aspect_ratio: "9:16"`,
`generate_audio`, `seed` (only if the model supports it), `frame_images: [{ type: "image_url",
image_url: { url: "data:<mime>;base64,…" }, frame_type: "first_frame" }]` and
`provider: { data_collection: "deny" }`. Only parameters the request uses are sent. Polling uses
`GET /api/v1/videos/{id}`; download uses `GET /api/v1/videos/{id}/content?index=0` with the key
(never the signed `urls`, which are secrets and are not logged). Errors map to the M2
`ProviderError` codes (400 → `invalid_request`, 401/403 → `auth`, 402 → `insufficient_credits`,
429 → `rate_limited`, 5xx → `provider_unavailable`). The data-URL frame input is confirmed by the
first paid smoke; if it is refused, the fallback is a short-lived presigned storage URL (needs a
public storage endpoint on staging; decision then).

### 3.3 Models (V12)

`pnpm ai:registry model import-openrouter-videos` imports catalog records as **disabled** models
with constraints and prices (§9). Seeded benchmark candidates (prices at 2026-11-19, 720p, no
audio, 30 s pilot = 5 × 6 s):

| Model                    | Why                                                        | 30 s pilot |
| ------------------------ | ---------------------------------------------------------- | ---------: |
| `google/veo-3.1-lite`    | cheapest well-known model with first/last frame, seed      |      $0.90 |
| `alibaba/wan-3.0`        | durations 2–30 s (fits any scene), 480p draft option, seed |      $3.00 |
| `kwaivgi/kling-v3.0-std` | a third vendor family; 3–15 s, first and last frame        |      $2.52 |

Benchmark (AI_PROVIDER_STRATEGY §9): the demo character's 3 approved keyframes × 3 models ×
~3 samples (≈ 10 per model, 6 s, 720p) → about $12.84; **cap USD 15** enforced by the CLI
(`smoke-video --max-cost-usd`). Scores: identity vs keyframe, motion, prompt adherence, artefacts,
latency, failures, cost. The owner enables and routes one (`route set video_generation …`).

## 4. TTS provider

### 4.1 Interface and adapter (V2)

`TtsProvider.synthesize({ text, voice, language?, speed?, instructions?, format: 'mp3' })` →
`{ bytes, mimeType, providerRequestId, reportedCost? }`. OpenRouter adapter: `POST
/api/v1/audio/speech` with `response_format: "mp3"` (models that return only PCM are wrapped as
WAV), `provider: { zdr: true, data_collection: "deny" }`. Cost: `X-Generation-Id` → `GET
/api/v1/generation?id=…` (reported); before that the registry estimate per character.
`MockTtsProvider` produces a real MP3 (FFmpeg tone) whose length follows the text length.

### 4.2 Models (V12)

| Model                          | $/M chars | Note                                         |
| ------------------------------ | --------: | -------------------------------------------- |
| `elevenlabs/eleven-flash-v2.5` |        40 | Vietnamese listed by ElevenLabs; low latency |
| `elevenlabs/eleven-v4`         |        80 | most expressive; Vietnamese to confirm       |
| `microsoft/mai-voice-2.1`      |        22 | native `vi-VN` voices                        |

A 30 s script (~450 characters) costs $0.01–0.04. Benchmark: the pilot script in Vietnamese and
English × 3 models × 3 voices; **cap USD 2**.

## 5. Async job lifecycle (V3)

### 5.1 Data

`generation_jobs` gains: `provider_job_id` (unique when set), `provider_status`,
`submitted_at`, `last_polled_at`, `next_poll_at`, `poll_count`, `provider_expires_at`. New kinds
`video_generation` and `tts_generation` (both require `storyboard_scene_id`). New queues
`generation-video` and `generation-audio` with their own concurrency
(`WORKER_VIDEO_CONCURRENCY`, default 4 — poll steps are short; `WORKER_AUDIO_CONCURRENCY`,
default 2).

### 5.2 Video job steps

1. **Submit** (BullMQ job "submit"): load the job, mark `running`, `attempt += 1`; record the
   invocation (`started`); call `submit`. On `202`: in **one transaction** store
   `provider_job_id`, `submitted_at`, `next_poll_at = now + 15 s`; then enqueue a delayed "poll".
2. **Poll** (delayed BullMQ job): `GET` status; update `provider_status`, `poll_count`,
   `last_polled_at`. Schedule 15 s → 30 s → 60 s (cap 60 s), wall limit 45 min
   (`VIDEO_POLL_TIMEOUT_MS`). Poll errors (network, 5xx, 429) retry with backoff; they cost
   nothing.
3. **Completed**: record reported cost (invocation `succeeded`); download each output, stream to a
   temp file (size cap 200 MB), FFprobe (§8), write-once to storage, insert the `video` asset
   (`generated`, `pending`, job, scene, content item; `asset_inputs` → keyframe), mark the job
   `succeeded` — assets and transition in one transaction.
4. **Failed / cancelled / expired** at the provider: job `failed` with `PROVIDER_FAILED`,
   `PROVIDER_CANCELLED` or `PROVIDER_EXPIRED` and the provider's message; cost as reported, else
   `unknown`. **No automatic resubmit.**

### 5.3 Restarts and ambiguity

The reconciler (ADR-0013) changes for video jobs only:

| State found                                                                                                                   | Action                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` with `provider_job_id`, no live BullMQ job                                                                          | enqueue a "poll" (never a submit)                                                                                                            |
| `running` without `provider_job_id`, submit never sent                                                                        | requeue the submit (safe: the attempt is recorded before the HTTP call; "not sent" = connection refused/DNS)                                 |
| `running` without `provider_job_id`, submit **may** have reached the provider (timeout, lost response, crash during the call) | `failed` with `SUBMIT_OUTCOME_UNKNOWN`; invocation `outcome_unknown`, cost `unknown`; the UI explains that regenerating may be charged twice |
| `failed` with `PROVIDER_TIMEOUT` and `provider_job_id`                                                                        | user action **Check again** (`POST /generation-jobs/:id/recheck`) enqueues one poll; free                                                    |

Cancelling one of our video jobs stops polling only; the UI says the provider may still charge
(OpenRouter has no cancel endpoint).

### 5.4 Errors shown to the user

| Code                                        | Retried automatically           | Message and action in the UI                                                       |
| ------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `INVALID_REQUEST` (400)                     | no                              | Parameter not supported by the model (shows the provider text); pick another model |
| `INSUFFICIENT_CREDITS` (402)                | no                              | Top up OpenRouter credits, then regenerate                                         |
| `AUTH` (401/403)                            | no                              | Operator: check the provider key                                                   |
| `CONTENT_POLICY`                            | no                              | Change the video prompt or keyframe                                                |
| `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`      | yes (3, backoff, `Retry-After`) | — (shown only after exhaustion)                                                    |
| `PROVIDER_FAILED` / `CANCELLED` / `EXPIRED` | no                              | Provider message; regenerate the scene                                             |
| `PROVIDER_TIMEOUT`                          | no                              | Still processing at the provider: **Check again**                                  |
| `SUBMIT_OUTCOME_UNKNOWN`                    | no                              | We could not confirm the submit; regenerating may be charged twice                 |
| `OUTPUT_INVALID`                            | no                              | The file failed validation (FFprobe details); regenerate                           |
| `OUTPUT_EXPIRED`                            | no                              | The provider deleted the output before download; regenerate (cost recorded)        |

### 5.5 TTS job steps

Synchronous call (timeout 120 s) like M4 images: invocation → call → FFprobe → write-once →
`audio` asset (`generated`, scene) → `succeeded`. A lost TTS response is cheap (≤ $0.04) and
retried by the M3 policy.

## 6. Video generation

### 6.1 Jobs (V4)

One `video_generation` job per scene of the **approved** storyboard, only for scenes with a
keyframe (gate 3 for that scene; generating before every scene has one is allowed). `count` 1
(default) or 2 → two submissions, two candidate assets. Execution key: scene fields that affect
the clip (`videoPrompt`, `cameraMovement`, `characterAction`, `durationSeconds`), keyframe asset
id, model, requested duration, resolution, `generateAudio`, prompt template `video.v1`. Same key +
succeeded result → reuse (no call) unless `regenerate`.

Prompt `video.v1` (no LLM call): scene video prompt + camera movement + character action, plus a
fixed instruction to keep the first frame's subject and composition. Snapshot stored on the job.

### 6.2 Duration (V5)

`requested = min{ d ∈ supported_durations : d ≥ ceil(scene.durationSeconds) }`. If none exists
(scene longer than the model maximum), the estimate marks the scene `exceeds_model_maximum` and
the scene is not generated until it is shortened or another model is chosen. Billing and
estimates use `requested`. M6 trims to the scene duration.

### 6.3 Validation of a clip

FFprobe: readable container (MP4/MOV), one video stream (H.264/HEVC/VP9/AV1), dimensions in 9:16
(±1 %), duration ≥ 90 % of `requested`, audio stream presence recorded. Stored on the asset:
`width`, `height`, `durationMs`, `metadata.video { codec, fps, bitrate, hasAudio }`, checksum.
Clips below the target resolution are recorded as they are; nothing is upscaled (CLAUDE.md §8).

### 6.4 Review and selection (V6)

Candidates are approved/rejected like images. `PUT /scenes/:sceneId/clip { assetId }` selects an
approved `video` candidate of that scene (or of an identical scene of an earlier version whose
keyframe is the same asset) — `scene_clips` with an event log, enforced by a trigger like `AC015`.
Changing a scene's keyframe clears its clip selection (the clip no longer starts from it).

## 7. Audio

### 7.1 Voice profiles (V7)

`voice_profiles` (project-scoped): name, TTS model, provider voice id (validated against
`supported_voices` when the catalog lists them), language, speed, instructions, archived flag.
Owners and editors manage them (Settings). A content item points to one profile
(`content_items.voice_profile_id`); jobs snapshot every voice parameter in their input, so later
profile edits never change past outputs.

### 7.2 Voice-over jobs

One `tts_generation` job per scene with a non-empty `voiceOverSegment` (approved storyboard).
Execution key: segment text, language, model, voice, speed, instructions. The measured duration
is stored; if a voice-over is longer than the scene, the scene is flagged
(`voiceover_exceeds_scene`) for the user (shorten the text or the speed; M6 will not stretch
silently). Candidates approved per scene; `PUT /scenes/:sceneId/voiceover { assetId }` →
`scene_voiceovers`.

### 7.3 Audio import (V8)

`POST /projects/:projectId/assets/upload?assetType=audio` (raw body, ≤ 25 MB, magic bytes +
FFprobe; MP3, WAV, M4A/AAC). `purpose=voiceover` uploads may be selected as a scene's voice-over;
`purpose=music` requires `licenseNote` (stored in `source_note`) and is listed for M6. Imported
audio is `upload`, not `generated`; its cost is zero (no AI call).

## 8. Media tooling (V9)

- `packages/media` (new): `probe(file)` (FFprobe JSON via `execFile`, argument arrays, timeout,
  no shell) and validators for video and audio; `ffmpeg` helpers for the mocks only.
- Deploy image: `apt-get install --no-install-recommends ffmpeg` (Debian bookworm package,
  5.1.x); CI (`ubuntu-latest`) installs `ffmpeg` in the E2E and integration jobs. Local
  development: documented prerequisite (`ffprobe -version`). The API and worker refuse to start
  media features without FFprobe (`503 MEDIA_TOOLS_MISSING`), like storage in M4.
- `GET /assets/:assetId/content` supports **HTTP Range** (`206`, `Accept-Ranges: bytes`) using the
  existing `ObjectStore.get(key, range)`, so `<video>`/`<audio>` can seek.

## 9. Cost (V10, V11)

### 9.1 Prices

New `AiPriceMetric` values: `output_video_seconds` (variant = resolution and audio, e.g.
`720p`, `720p_audio`, `default`), `input_characters` (TTS), and `output_video_tokens` (recorded
only; no estimate). Existing `input_images` covers per-input-image SKUs. The import CLI maps known
SKU patterns (verification record §1.1), converts cents to USD exactly, and stores unrecognised
SKUs in the model's notes with price **unknown**. Estimates: `requested_seconds ×
price(variant)` per scene; TTS `characters × price`. Unknown → explicit acceptance
(`acceptUnknownCost`, M4 rule). Recorded cost: the provider's `usage.cost` (`reported`).

### 9.2 Spend guard until M7

- Every video generate request requires the estimate to have been shown: the API takes
  `confirmedEstimateUsd` and refuses (`409 ESTIMATE_CHANGED`) if the current estimate is higher.
- `VIDEO_MAX_ESTIMATED_USD_PER_REQUEST` (default 5) refuses larger requests
  (`422 SPEND_GUARD`); unknown estimates count as above the guard unless accepted explicitly.
- M7 replaces this with project/content budgets and reservations (COST_STRATEGY §4).

## 10. Risks

| ID  | Risk                                                                      | Mitigation                                                                                                                        |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| R1  | No ZDR for video: keyframes (character likeness) retained by the provider | `data_collection: deny`; owner reviews the provider's terms before enabling a model; project deny list (AI_PROVIDER_STRATEGY §10) |
| R2  | Double charge on a lost submit (no idempotency key)                       | Never auto-resubmit (§5.3); explicit user decision; cost `unknown` recorded                                                       |
| R3  | Billing of failed/expired jobs undocumented                               | Record the reported cost when present, else `unknown`; benchmark observes it                                                      |
| R4  | Data-URL frames not accepted by some endpoints                            | Confirmed in the first smoke per model; fallback presigned URL (decision then)                                                    |
| R5  | Discrete durations waste paid seconds (e.g. 4.2 s scene billed 6 s)       | Estimate shows billed seconds; storyboard guidance favours supported durations; Wan 3.0 offers 2–30 s                             |
| R6  | Catalog/price drift (35 models, heterogeneous SKUs)                       | Registry data with effective dates; re-import; unknown estimates never shown as $0                                                |
| R7  | Vietnamese TTS quality varies                                             | Benchmark with the real script; voice profile per project; audio import as fallback                                               |
| R8  | 720p clips below 1080×1920 output                                         | Record real dimensions; M6 decides scaling and reports it; 1080p option per request                                               |
| R9  | Long polls hold resources                                                 | Delayed BullMQ jobs, no sleeping workers; bounded schedule and wall limit                                                         |
| R10 | Large files through the API                                               | ≤ 200 MB worker download cap; Range streaming; browser-direct uploads stay out of scope                                           |

## 11. API (base `/api/v1`)

| Endpoint                                                        | Viewer  | Editor/Owner | Notes                                                                                                      |
| --------------------------------------------------------------- | :-----: | :----------: | ---------------------------------------------------------------------------------------------------------- |
| `POST /storyboards/:id/videos/estimate`                         |    ✓    |      ✓       | `{ sceneIds?, count?, resolution?, generateAudio?, modelKey? }` → per scene: billed seconds, price, action |
| `POST /storyboards/:id/videos/generate`                         |   403   |     202      | Same + `confirmedEstimateUsd`, `acceptUnknownCost?`, `regenerate?`                                         |
| `GET /storyboards/:id/videos`                                   |    ✓    |      ✓       | Per scene: clip, candidates, active/last job (provider status, polls), flags, cost                         |
| `PUT /scenes/:sceneId/clip`                                     |   403   |      ✓       | `{ assetId }`                                                                                              |
| `POST /generation-jobs/:id/recheck`                             |   403   |      ✓       | Video jobs with a provider job id after `PROVIDER_TIMEOUT`                                                 |
| `GET/POST /projects/:id/voice-profiles`, `PATCH/POST …/archive` | ✓ / 403 |      ✓       | §7.1                                                                                                       |
| `PATCH /content/:id`                                            |   403   |      ✓       | + `voiceProfileId`                                                                                         |
| `POST /storyboards/:id/voiceovers/estimate`, `/generate`        | ✓ / 403 |   ✓ / 202    | Per scene with voice-over text                                                                             |
| `GET /storyboards/:id/voiceovers`                               |    ✓    |      ✓       | Per scene: selected voice-over, candidates, duration vs scene                                              |
| `PUT /scenes/:sceneId/voiceover`                                |   403   |      ✓       | `{ assetId }` (generated or imported `voiceover` audio)                                                    |
| `POST /projects/:id/assets/upload?assetType=audio`              |   403   |     201      | §7.3                                                                                                       |
| `GET /assets/:assetId/content`                                  |    ✓    |      ✓       | + Range                                                                                                    |

This replaces API_SPEC's draft `POST /scenes/:sceneId/video-generations` and
`POST /content/:contentId/tts-generations` with storyboard-scoped batches, consistent with M4.
New error codes: `KEYFRAME_REQUIRED`, `EXCEEDS_MODEL_MAXIMUM`, `ESTIMATE_CHANGED`,
`SPEND_GUARD`, `VOICE_PROFILE_REQUIRED`, `CLIP_INVALID`, `VOICEOVER_INVALID`,
`MEDIA_TOOLS_MISSING`, `LICENSE_NOTE_REQUIRED`. All endpoints join the permission matrix.

## 12. Web UI (M4.5 design system)

- Content workspace: stepper **Brief → Script → Storyboard → Keyframes → Clips → Voice-over →
  Export**; new tabs **Clips** (per scene: keyframe, clip candidates with `<video>` players,
  provider status and elapsed time, estimate dialog with billed seconds, approve/reject/use,
  regenerate, Check again) and **Voice-over** (profile picker, per-scene audio players, duration
  vs scene, upload replacement). Checklist and cost box include video and TTS jobs.
- Settings: voice profiles (owners/editors), preview a voice with a short sample (counts as a TTS
  call, shown with its cost).
- Asset library: video and audio thumbnails/players; music uploads with licence note.
- Pipeline board: column "Clips & voice-over".

## 13. Testing

| Layer               | What                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                | duration mapping; SKU parsing (all patterns in §1.1 of the record, cents, unknown); estimates; prompt `video.v1`; execution keys and reuse; poll schedule; error mapping  |
| Contract (fixtures) | OpenRouter video: 202, poll sequence, completed with cost, failed, expired, 400 with supported values, 402, 429, 5xx, download; TTS: mp3, pcm→wav, `X-Generation-Id` cost |
| Media               | FFprobe on fixture MP4/MP3/WAV/broken files; Range responses                                                                                                              |
| DB integration      | migration `m5_media`, CHECKs, clip/voice-over triggers, unique provider job id                                                                                            |
| Worker integration  | real PostgreSQL + Redis + SeaweedFS + mocks: success; restart after submit (one submission); ambiguous submit; timeout + recheck; expiry; reuse; TTS                      |
| API integration     | every endpoint, permission matrix, gates, spend guard, estimate confirmation, audio upload                                                                                |
| E2E (Playwright)    | keyframes → estimate → generate clips (mock) → play → approve → voice profile → voice-overs → approve → gate 4                                                            |
| Paid smoke (manual) | `smoke-video` (default cap USD 1) and `smoke-tts` (USD 0.10), `ACF_PAID_SMOKE=1`; benchmark caps V12                                                                      |

## 14. Implementation plan (each slice tested before the next)

| Slice | Scope                                                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M5a   | FFmpeg in deploy image and CI; `packages/media` (FFprobe, validators); Range streaming; audio upload; docs                                                                    |
| M5b   | `VideoProvider`/`TtsProvider`, OpenRouter video and TTS adapters, mocks, fixture contract tests; price metrics and SKU import; `import-openrouter-videos`/`-tts`; paid smokes |
| M5c   | Migration `m5_media`; worker video processor (submit/poll/download/validate), reconciler rules, TTS processor; worker integration tests (restart, ambiguity, expiry, reuse)   |
| M5d   | API: estimates, generation, views, selection, recheck, voice profiles, spend guard; status transitions; gate 4; permission matrix                                             |
| M5e   | Web UI (clips, voice-over, voice profiles, players); Playwright E2E with mocks; docs; ADR-0017 (async provider jobs)                                                          |

The paid benchmark (V12) runs when an OpenRouter key is available, before any video or TTS model
is enabled; it can share a session with the pending M4 image benchmark.

## 15. Implementation deviations (recorded at delivery, M5a–M5e)

The approved decisions V1–V12 hold. These details changed during implementation:

| #   | Package said                                                                    | Implemented                                                                                                                                                                                    | Why                                                                                                                                 |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `count` 1 or 2 clips per scene (§6.1)                                           | One clip per video job; more candidates come from "Regenerate scene"                                                                                                                           | One active job per scene and kind keeps the restart/ambiguity rules simple; a second submission is a deliberate, priced user action |
| 2   | Poll 15 s → 30 s → 60 s (cap 60 s), wall limit 45 min (`VIDEO_POLL_TIMEOUT_MS`) | 15 s, 30 s, 60 s, then +60 s up to 5 min; last-resort limit 6 h (`VIDEO_POLL_LIMIT_MS`) → `PROVIDER_TIMEOUT`                                                                                   | The provider bounds its own jobs (`expired`); slow queues must not be failed while still billable                                   |
| 3   | "Check again" on a `failed` `PROVIDER_TIMEOUT` job                              | `POST /generation-jobs/:id/recheck` runs the pending poll of a **running** video job now (`409 JOB_NOT_RECHECKABLE` otherwise)                                                                 | Failed jobs are immutable (M3 guard); with deviation 2 a timeout is rare and final                                                  |
| 4   | Submit step named "submit"                                                      | The submit is the job's `generate` BullMQ job; polls are `poll` jobs                                                                                                                           | Reuses the existing enqueue path, reconciler and outbox                                                                             |
| 5   | One migration `m5_media`                                                        | `m5_media_registry` (M5b), `m5_job_kinds` (enum values) and `m5_media`                                                                                                                         | PostgreSQL cannot use an enum value in the transaction that adds it                                                                 |
| 6   | —                                                                               | Content status reuses the image events (`image_jobs_queued`/`settled`) for every scene media job                                                                                               | Same states (`generating_assets` → `asset_review`); no new enum values                                                              |
| 7   | Reconciler requeues a submit that was never sent                                | Never sent = the provider refused it: the processor clears the intent and retries in the same delivery; a running job with an intent but no provider job id is always `SUBMIT_OUTCOME_UNKNOWN` | The worker cannot prove "not sent" after a crash                                                                                    |
| 8   | `KEYFRAME_REQUIRED`, `EXCEEDS_MODEL_MAXIMUM` errors                             | Plan actions `skip_no_keyframe`, `skip_exceeds_model_maximum` (codes reserved)                                                                                                                 | A batch can still generate the other scenes                                                                                         |
| 9   | Clip candidates via the execution key of identical scenes                       | Candidates: clips of the scene and clips generated from the same keyframe asset (`asset_inputs`)                                                                                               | Visible reuse across storyboard versions without recomputing hashes per model                                                       |
| 10  | Settings: voice preview (a paid TTS call)                                       | Not built                                                                                                                                                                                      | A preview is a paid call outside any job and ledger flow; deferred                                                                  |
| 11  | Stepper with Clips and Voice-over steps; pipeline board column                  | One "Clips & voice" step and two tabs; board unchanged                                                                                                                                         | Content statuses did not change, so the board has no new column                                                                     |
| 12  | —                                                                               | `WORKER_VIDEO_POLL_SCALE` (default 1) scales the poll schedule for tests and E2E                                                                                                               | E2E finishes mock clips in under a second                                                                                           |
| 13  | E2E plays clips                                                                 | E2E checks the clip stream over HTTP (`206`, `video/mp4`, `ftyp`) and plays the MP3 voice-overs                                                                                                | Playwright's Chromium has no H.264 decoder                                                                                          |
| 14  | —                                                                               | Canceling a run with a submitted video records the invocation as `outcome_unknown` (`CANCELED_BY_USER`)                                                                                        | No cancel endpoint at the provider: it may still charge                                                                             |

M5 status (approved by the owner, 2026-11-19): all slices delivered and tested (unit, contract, database, worker and API integration,
permission matrix, Playwright E2E with mock providers and real FFmpeg). The paid benchmark (V12)
still waits for an OpenRouter API key; no video or TTS model is enabled until it has run.
