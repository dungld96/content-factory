# Post-MVP Feature Audit

- **Date:** 2026-11-20
- **Branch:** `claude/gracious-planck-kuf4pq` (commit `11b3ddf`)
- **Scope:** audit only. No code, schema, migration, contract or dependency changes.
- **Areas:** P1 OpenRouter Settings UI · P2 Asset Library · P3 Worker Monitoring & Smart
  Recovery · P4 Audio Configuration

Every finding was traced in the code (web → API → service → database → worker). File paths
are relative to the repository root.

Status legend: **IMPLEMENTED** · **PARTIALLY IMPLEMENTED** · **MISSING** · **NEEDS REFACTORING**.

---

## Summary

| Area                     | Main finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 OpenRouter Settings   | The registry and routing are complete but can only be written through the CLI. **There is no platform-level admin role**, and the registry is global, so a Settings UI must not use project roles. Keep the API key in the environment: show its status and test it, but never accept or store it through the UI.                                                                                                                                                                                     |
| P2 Asset Library         | The Library is already the **only upload path** (no stage-level uploads), and production inputs are bound by asset ID and frozen. Missing: **collections**, **character and environment UI**, and **reference picking in briefs and scenes**. Three integrity or UX gaps: uploads cannot be approved from the Library, so uploaded music is unusable without the API; `PATCH /assets/:id` can overwrite system metadata (`purpose`, audio probe data); lineage and usage views ignore `asset_inputs`. |
| P3 Monitoring & Recovery | The backend is solid: reconciler, dead-letter, circuits, resume, execution keys, held reservations. The UI exposes little of it: no cancel, no job-event history, no run view. **Resume from the UI fails for clip runs**, because the button never sends `confirmedEstimateUsd`. Soft budget confirmations are not handled either.                                                                                                                                                                   |
| P4 Audio                 | One voice-over per scene plus one ducked music bed with a single volume control. **No SFX, no per-scene audio, no layer toggles, no mix settings in the render settings.** Native clip audio can be requested (and paid for) but the render always drops it (`-an`).                                                                                                                                                                                                                                  |

**Recommended order:** P3 (small, fixes recovery bugs) → P2 integrity fixes → P1 → P2 features → P4.
See §E.

---

# A. Current implementation

## A1. OpenRouter settings, registry and routing

**Frontend**

| File                                                             | What it does                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/app/(studio)/settings/page.tsx` (`SettingsPage`)   | Account, project profile (`ProjectSettingsForm`), voice profiles (`VoiceProfilesCard`), system health. **No provider, model or route section.**                          |
| `apps/web/src/components/model-select.tsx` (`ModelSelect`)       | Per-request model override ("Default (task route)" sends no `modelKey`). Used in `pipeline-controls.tsx` (script, storyboard), `scene-images.tsx` and `scene-clips.tsx`. |
| `apps/web/src/app/(studio)/content/[contentId]/page.tsx:248-252` | Loads `/ai/models?capability=…&status=enabled` for those pickers.                                                                                                        |
| `apps/web/src/components/voice-profiles.tsx`                     | TTS model and voice picker, fed by `/ai/models?capability=tts`, which returns `voices`.                                                                                  |

`GET /ai/providers` and its `configured` flag are **not used anywhere in the web app**.

**API (read-only)**

| Endpoint                                                       | Code                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /ai/providers`                                            | `apps/api/src/ai/registry/registry.controller.ts` → `RegistryService.listProviders` |
| `GET /ai/models` (filters: capability, status, tier, provider) | `RegistryService.listModels`. Returns active prices, limits, `voices`               |
| `GET /ai/models/:modelId`                                      | `RegistryService.getModel`. Adds the price history                                  |

Any signed-in user may read these; nothing writes the registry over HTTP (controller comment,
"decision E3"). Routes (`ai_task_routes`) are **not exposed** over HTTP at all.

**Services and writes (CLI only)**

- `apps/api/src/ai/registry/registry-admin.service.ts` (`RegistryAdminService`, a plain class,
  not a Nest provider): `setProviderStatus`, `setModelStatus`, `setSchemaMode`,
  `setMinBilledSeconds`, `setRoute` (checks the capability; allows a disabled model), `addPrice`,
  `applyOpenRouterImport`, `applyOpenRouterImageImport`, `applyOpenRouterMediaImport`.
- `apps/api/src/cli/ai-registry-cli.ts`: every operator command (provider, model, price, route,
  circuit, invocations, imports, paid smoke tests).
- Catalog readers: `apps/api/src/ai/providers/openrouter-catalog.ts`,
  `openrouter-image-catalog.ts`, `openrouter-media-catalog.ts` (public, unauthenticated endpoints).
- Route resolution: `GenerationService.resolveModel` (`apps/api/src/generation/generation.service.ts:507`),
  `ImagesService` (`images.service.ts:450`), `VideosService` (`videos.service.ts:464`), then
  `ModelCatalog.candidates` and `filterCandidates` (`packages/ai-core/src/routing.ts`).

**Credentials**

- `OPENROUTER_API_KEY` is validated in `packages/config/src/ai-provider-env.ts` (empty counts as
  unset) and passed by `infra/deploy/docker-compose.yml` to the api, worker and migrate containers.
  `infra/deploy/generate-env.sh` writes it empty.
- Adapters are built **once at process start**: `createLlmProviders`, `createImageProviders`
  (`packages/ai-runtime/src/providers/llm-providers.ts`, `image-providers.ts`),
  `createVideoProviders`, `createTtsProviders` (`media-providers.ts`). Wired in
  `apps/api/src/ai/ai.module.ts` and the worker's `main.ts`. A key change needs an API **and**
  worker restart.
- `RegistryService.isConfigured` checks **only the LLM provider map**.
- The adapters have no key-check call. The verification record lists `GET /key`
  (`limit_remaining`, `usage*`, `is_free_tier`) in `docs/design/m2/openrouter-verification.md` §3.

**Database:** `ai_providers`, `ai_models`, `ai_model_capabilities`, `ai_model_prices`
(append-only, `AC011`), `ai_task_routes`, `ai_invocations`, `ai_usage_records`,
`provider_circuits` and `provider_circuit_events` (in `packages/database/prisma/schema.prisma`).
**No audit table for status or route changes**; only manual circuit changes are recorded.

**Roles:** `ProjectRole` (owner, editor, viewer) is per project. `User` has **no platform role**
(`schema.prisma`, `model User`). The registry and routes are global.

**Tests:** `apps/api/test/ai/registry.integration.test.ts` (read API),
`registry-cli.integration.test.ts`, `media-cli.integration.test.ts`,
`llm-service.integration.test.ts`, `image-service.integration.test.ts`; adapter contract tests in
`packages/ai-core/src/openrouter/*contract.test.ts`; env tests in `packages/config/src/api-env.test.ts`.

## A2. Asset Library

**Frontend**

| File                                                                                                                   | What it does                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/app/(studio)/assets/page.tsx` (`AssetsPage`)                                                             | Loads **every page of every project's assets** (`apiGetAll`) and filters by type, project and search text in the server component. Has an upload button.                                                                                               |
| `apps/web/src/app/(studio)/assets/asset-browser.tsx` (`AssetBrowser`, `LineagePanel`, `useProvenance`, `MediaPreview`) | Grid with image thumbnails and players for video and audio. The selected asset shows file details, its job, model, template and cost, "Derived from" (`/lineage`) and "Used by" (`/usages`). **Read-only: no approve, reject, label edit or archive.** |
| `apps/web/src/components/forms.tsx` (`UploadForm`, `UploadAssetButton`) → `apps/web/src/lib/api-client.ts:119`         | **The only upload entry point in the web app.** Reference or image files, or audio with `purpose` voiceover or music plus a licence note.                                                                                                              |
| `scene-images.tsx`, `scene-clips.tsx`, `scene-voiceovers.tsx`                                                          | Approve or reject candidates and choose the scene's keyframe, clip or voice-over (`PUT /scenes/:id/keyframe                                                                                                                                            | clip | voiceover`). The voice-over tab also lists **Library uploads** with `purpose=voiceover`. |
| `render-panel.tsx`                                                                                                     | Music is picked from **approved Library uploads** with `purpose=music` (`plan.musicOptions`).                                                                                                                                                          |

**Not in the web app at all:** characters and environments with their versions and reference
links (API only); the brief's `characterId` and `environmentId`
(`packages/contracts/src/content.ts:49-51`); scene `requiredReferenceAssetIds`
(`packages/content-domain/src/storyboard.ts:28`), which the scene editor does not expose.

**API**

| Endpoint                                                                                        | Code                                                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /projects/:id/assets` (metadata registration)                                             | `apps/api/src/assets/assets.controller.ts` → `AssetsService.register`                  |
| `POST /projects/:id/assets/upload`                                                              | `AssetsService.upload`: magic bytes, FFprobe (`inspectAudio`), SHA-256, write-once key |
| `GET /assets/:id/content` (Range)                                                               | `AssetsService.content`                                                                |
| `GET /projects/:id/assets` (assetType, contentItemId, includeArchived)                          | `AssetsService.list`                                                                   |
| `GET /assets/:id`, `PATCH /assets/:id` (label, **metadata**), `POST …/archive`                  | `get`, `update`, `archive`                                                             |
| `GET /assets/:id/lineage`                                                                       | `AssetsService.lineage`: recursive over **`source_asset_id` only**                     |
| `GET /assets/:id/usages`                                                                        | `AssetsService.usages`: **character and environment versions only**                    |
| `POST /assets/:id/approve                                                                       | reject`                                                                                | `apps/api/src/generation/images.controller.ts:104` → `ImagesService.review` (images, references, video, audio) |
| Brand: `/projects/:id/characters`, `/characters/:id/versions`, `/character-versions/:id/(assets | approve)` and the environment equivalents                                              | `apps/api/src/brand/versioned-entity.controller.ts`, `versioned-entity.service.ts`                             |

**Binding and reproducibility (verified)**

- Asset file identity is immutable (`AC005`); storage is write-once. There is **no replace
  operation**: a new file is a new asset.
- Scene references: `storyboard_scene_assets` rows hold the real asset IDs (written in
  `ArtifactsService.editScene`, `artifacts.service.ts:232`, and in
  `apps/worker/src/generation-processor.ts:390`). Editing creates a new storyboard version.
- Image references come from the scene's **pinned** `characterVersion` / `environmentVersion`
  primary asset (`referencesOf`, `images.service.ts:93`). Approved versions are immutable, so a
  later master change does not alter past scenes.
- Each generated asset records its inputs in `asset_inputs` (role `character`, `environment`,
  `scene_reference`, `keyframe`, `clip`, `voiceover`, `music`), written by the worker
  (`generation-processor.ts`, `media-jobs.ts`, `render-jobs.ts`). **The API never reads
  `asset_inputs`.**
- The image execution key includes the reference asset IDs (`packages/content-domain/src/images.ts:69-78`).
- Renders freeze every input asset ID in `renders.manifest` (`renderManifestSchema`,
  `packages/content-domain/src/render.ts:44`).
- Selections (`scene_keyframes`, `scene_clips`, `scene_voiceovers`) are guarded by `AC015` and
  `AC016`, and the selected assets cannot be archived (`AC008`).
- The `purpose` of an upload (voiceover or music), its FFprobe details, and the `clipHash` used
  for clip reuse live in the mutable `assets.metadata` JSON.

**Collections:** **none.** No table, endpoint or UI (`grep -i collection` finds nothing in the
schema, API or contracts).

**Tests:** `apps/api/test/workspace/assets.integration.test.ts`,
`asset-upload.integration.test.ts`, `brand.integration.test.ts`;
`packages/database/test/images.integration.test.ts` and `media.integration.test.ts` (asset
triggers); `apps/web/e2e/masters.spec.ts` (reference upload), `studio.spec.ts`;
`packages/storage/src/storage.test.ts`.

## A3. Worker monitoring and recovery

**Frontend**

| File                                                                                     | What it does                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/(studio)/operations/page.tsx`                                          | 24-hour stats, queue depths, the latest 50 failed jobs (stage, code, message, time, **Resume**), held reservations (`reservation-actions.tsx`), provider circuits, budgets. |
| `apps/web/src/components/resume-run.tsx` (`ResumeRunButton`)                             | `POST /production-runs/:id/resume`; asks before a possible double charge by **matching the error message text**.                                                            |
| `apps/web/src/app/(studio)/content/[contentId]/pipeline-controls.tsx` (`GenerateButton`) | Polls the job (`setInterval` → `/generation-jobs/:id`), shows status, attempt and error code, and Resume on failure.                                                        |
| `scene-images.tsx`, `scene-clips.tsx`, `scene-voiceovers.tsx`                            | Per-scene "Regenerate scene N"; clips show the provider status and poll count; "Check again" (`recheck`).                                                                   |
| `apps/web/src/lib/format.ts` (`jobErrorText`)                                            | Readable text for 13 job error codes (mostly video).                                                                                                                        |
| `apps/web/src/app/(studio)/pipeline/page.tsx`                                            | Board by content status, with an "attention" filter.                                                                                                                        |

**Not in the UI:** run cancel (`POST /production-runs/:id/cancel` is never called from the web);
the job event history (`GenerationJobDto.events`, `packages/contracts/src/generation.ts:105`,
never rendered); any run view (`GET /production-runs/:id` is unused by the web).

**API and services**

- `apps/api/src/generation/generation.controller.ts`: runs, cancel, jobs, recheck.
- `apps/api/src/generation/resume.service.ts` (`ResumeService`): re-plans each failed or canceled
  job through the normal endpoint, in one new run (`resumedFromRunId`); skips `superseded`,
  `in_progress` and `outcome_unknown`.
- `apps/api/src/operations/ops.service.ts`, `operations.controller.ts`: summary and
  settle/release of held reservations. `costs.service.ts` computes retry cost.
- `apps/api/src/generation/generation.queue.ts`: enqueues with BullMQ id = job id.

**Worker**

- `apps/worker/src/generation-processor.ts`: text jobs; retries when `error.retryable &&
attempt < maxAttempts` (line 767).
- `apps/worker/src/media-jobs.ts` (`MediaJobs`): video submit → poll → download; an **unknown
  submit outcome becomes `SUBMIT_OUTCOME_UNKNOWN` and is never resubmitted** (line 180).
- `apps/worker/src/reconciler.ts` (`Reconciler.run`): re-enqueues `queued` jobs missing from
  Redis, requeues or fails (`WORKER_LOST`) orphaned `running` jobs, re-schedules lost video polls,
  never resubmits a started video.
- `apps/worker/src/job-store.ts`: state transitions, job events, settle/release/hold of
  reservations, budget re-check.
- `packages/ai-runtime/src/circuit-breaker.ts`; retry policy `RETRY_POLICY` and `retryDelayMs`
  (`packages/content-domain/src/jobs.ts:91-111`); error policy `PROVIDER_ERROR_POLICY`
  (`packages/ai-core/src/errors.ts:46`).

**Tests:** `apps/worker/test/reliability.integration.test.ts` (budget re-check, circuit, redaction),
`queue.integration.test.ts`, `processor.integration.test.ts`,
`media-processor.integration.test.ts`, `render-processor.integration.test.ts`,
`drills.integration.test.ts`; `apps/api/test/generation/operations.integration.test.ts` (resume:
new run, double-charge skip, nothing to resume; ops summary; costs).

## A4. Audio

**Frontend:** `voice-profiles.tsx` (model, voice, language, speed, instructions);
`scene-voiceovers.tsx` (estimate, generate, regenerate, approve, choose, overrun flag);
`render-panel.tsx` (captions burn-in, **one music track and one volume in dB**); the Library
upload form (audio with `purpose`).

**API:** `POST /storyboards/:id/voiceovers/estimate|generate`, `GET …/voiceovers`,
`PUT /scenes/:id/voiceover` (`apps/api/src/generation/media.controller.ts` →
`voiceovers.service.ts`); voice profiles (`voice-profiles.service.ts`, snapshotted into each job);
`GET /content/:id/render-plan`, `POST /content/:id/renders`
(`renders.controller.ts` → `renders.service.ts`); request schema `createRenderRequestSchema`
(`packages/contracts/src/renders.ts:59`): `captions.burnIn`, `music.assetId`,
`music.volumeDb` from −40 to 0.

**Render pipeline:** `packages/media/src/render.ts` (`renderVideo`):

- normalise: clips are re-encoded with **`-an`**, so native clip audio is dropped;
- narration: per scene, voice-over from the scene start, `apad` to the scene end, otherwise silence;
- mix: music looped, set to `volumeDb`, fixed 1.5 s fade-out, `sidechaincompress` ducking with
  fixed parameters, `amix`;
- loudness: two-pass `loudnorm` to −14 LUFS / −1 dBTP.

**Domain:** `renderManifestSchema` (per-scene clip, voice-over, durations, text, models; one
`music` entry with `volumeDb` and `licenseNote`), `renderSettings` (output, loudness, captions;
**no audio-mix block**), `renderExecutionKey` (manifest + settings), `DEFAULT_MUSIC_VOLUME_DB = -18`
(`packages/content-domain/src/render.ts`).

**Rules:** a scene with narration text and no chosen voice-over blocks the render
(`VOICEOVERS_INCOMPLETE`, `renders.service.ts:526`). A voice-over longer than its scene blocks it
(`VOICEOVER_EXCEEDS_SCENE`). Captions use the text only when the scene has a voice-over.

**Cost:** TTS reserves and records cost through `TtsService` and the budget reservations.
Music, the mix and rendering cost nothing.

**Tests:** `packages/media/src/render.test.ts`, `captions.test.ts`, `qc.test.ts`;
`apps/worker/test/render-processor.integration.test.ts`, `media-processor.integration.test.ts`;
`apps/api/test/generation/renders.integration.test.ts` (approved-music rule, licence note),
`media.integration.test.ts`; `pnpm media:selftest` (`packages/media/src/selftest.ts`).

---

# B. Gap analysis

## B1. OpenRouter Settings UI

| Requirement                           | Status                                  | Evidence                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key configuration                 | **PARTIALLY IMPLEMENTED**               | Environment only (`ai-provider-env.ts`), validated at startup, never logged (redaction test in `reliability.integration.test.ts`). It cannot be set from the UI, and that is correct: see §C1. |
| Key validation / test connection      | **MISSING**                             | No adapter method or endpoint. `GET /key` is verified in the M2 record but not implemented.                                                                                                    |
| Configured status in UI               | **PARTIALLY IMPLEMENTED**               | `configured` exists in `GET /ai/providers` but the web never shows it; it reflects only the LLM map (`RegistryService.isConfigured`).                                                          |
| Safe storage and masking              | **IMPLEMENTED** (environment)           | The key reaches only api, worker and migrate (`infra/deploy/docker-compose.yml`) and never a response.                                                                                         |
| Provider enable/disable               | **PARTIALLY IMPLEMENTED**               | `setProviderStatus` via CLI; no endpoint or UI; no audit row.                                                                                                                                  |
| Model enable/disable                  | **PARTIALLY IMPLEMENTED**               | `setModelStatus` via CLI; same gaps.                                                                                                                                                           |
| Task routing                          | **PARTIALLY IMPLEMENTED**               | `setRoute` and `route list` via CLI; routes are **not readable over HTTP**, so the UI cannot even show "Default (task route) = X".                                                             |
| Capability validation                 | **IMPLEMENTED**                         | `setRoute` requires the capability; `filterCandidates` checks enabled status, parameters and tier; image and video limits are checked per request.                                             |
| Capability and pricing information    | **IMPLEMENTED** (API), **MISSING** (UI) | `GET /ai/models` returns capabilities, limits, active prices and voices; the price history is in `/ai/models/:id`. No catalog page.                                                            |
| Authorization for global settings     | **MISSING**                             | There is no platform admin role. Project owners must not change global routes that every project uses.                                                                                         |
| Model list honours provider readiness | **NEEDS REFACTORING** (minor)           | Pickers filter `status=enabled` on the model only; a model of a disabled or unconfigured provider is still offered, and the API then refuses it.                                               |

## B2. Asset Library

| Requirement                                    | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library as the single upload path              | **IMPLEMENTED**           | `UploadAssetButton` is the only caller of `/assets/upload`; stage tabs only select. Keep it that way.                                                                                                                                                                                                                                                                                                                                                                                               |
| Browse and preview                             | **IMPLEMENTED**           | `AssetBrowser`, `MediaPreview`, authenticated Range streaming.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Scalable browsing                              | **NEEDS REFACTORING**     | `AssetsPage` loads every page of every project (`apiGetAll`) and searches in memory; there is no server-side search or `purpose` filter.                                                                                                                                                                                                                                                                                                                                                            |
| Review uploads (approve/reject) in the Library | **MISSING**               | The API allows it (`ImagesService.review`), but the Library UI has no control. **Uploaded music must be approved to be offered** (`renders.service.ts:438`), and the render panel tells users to approve it in the Library, where no button exists. Voice-over uploads can be approved only from the voice-over tab.                                                                                                                                                                                |
| Collections                                    | **MISSING**               | No schema, API or UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Select Library assets when creating content    | **MISSING**               | The brief accepts `characterId` and `environmentId`, but no web form or character/environment UI exists. Scene `requiredReferenceAssetIds` exists in the API (`PATCH /scenes/:id`) but not in the scene editor.                                                                                                                                                                                                                                                                                     |
| Character/environment reference management     | **PARTIALLY IMPLEMENTED** | Full versioned API and tests (`brand.integration.test.ts`); **no web UI**.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Persist selections by actual asset ID          | **IMPLEMENTED**           | `storyboard_scene_assets`, `character_version_assets`, primary asset IDs, selection tables, render manifest: all real UUIDs with composite FKs.                                                                                                                                                                                                                                                                                                                                                     |
| Retain exact generation bindings               | **IMPLEMENTED**           | `asset_inputs` (append-only); pinned versions in scenes; execution keys include reference IDs; frozen render manifest.                                                                                                                                                                                                                                                                                                                                                                              |
| Replacement does not change history            | **IMPLEMENTED**           | No replace operation; file identity immutable (`AC005`); versions immutable once approved (`AC001`, `AC002`).                                                                                                                                                                                                                                                                                                                                                                                       |
| Immutable production metadata                  | **NEEDS REFACTORING**     | `PATCH /assets/:id` replaces the whole `metadata` JSON (`AssetsService.update`), including `purpose` and `metadata.audio` written at upload. An editor can turn a voice-over into "music" or erase its probe data. **Clip reuse also matches on `metadata->>'clipHash'`** (`VideosService.reusableClip`, `videos.service.ts:651`), so a metadata edit can break or forge reuse of a paid clip. Historical renders stay correct (frozen manifest), but future eligibility and reuse change silently. |
| Lineage and version history display            | **PARTIALLY IMPLEMENTED** | `/lineage` follows only `source_asset_id`, so a generated clip shows "Nothing (original asset)" although `asset_inputs` records its keyframe. `/usages` lists only brand versions, not keyframes, clips, voice-overs, scene references or renders.                                                                                                                                                                                                                                                  |

## B3. Worker Monitoring & Smart Recovery

| Requirement                       | Status                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compact job monitoring            | **PARTIALLY IMPLEMENTED**                                       | Operations page (queues, failures, circuits) and per-button job lines; no single compact view per content or run.                                                                                                                                                                                                                                                                                                                                                                          |
| Expandable stage details          | **MISSING**                                                     | `job_events` are returned by `GET /generation-jobs/:id` (`events`) but never rendered; no run page.                                                                                                                                                                                                                                                                                                                                                                                        |
| Status and progress               | **IMPLEMENTED**                                                 | Job polling, attempt count, video `providerStatus` and `pollCount`, recheck.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Error messages and classification | **PARTIALLY IMPLEMENTED**                                       | Server-side classification is complete (`PROVIDER_ERROR_POLICY`, job codes). The UI maps 13 codes (`jobErrorText`, worded for clips); other codes (`WORKER_LOST`, `BUDGET_EXCEEDED`, `REFERENCE_MISSING`, `RENDER_QC_FAILED`, …) show raw. There is no "retryable / needs action / possibly charged" grouping in the UI.                                                                                                                                                                   |
| Retry per stage                   | **IMPLEMENTED**                                                 | Regenerate buttons per stage; Resume per run.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Scene-level retry                 | **IMPLEMENTED**                                                 | "Regenerate scene N" (images, clips, voice-overs) with `sceneIds` + `regenerate`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Resume failed runs                | **PARTIALLY IMPLEMENTED**                                       | The API is complete and tested. **The UI cannot finish a clip resume:** `ResumeRunButton` sends `{}` or `{acceptPossibleDoubleCharge}` only, `ResumeService` passes `confirmedEstimateUsd` only if given (`resume.service.ts:166`), and video generation then answers `409 ESTIMATE_CHANGED`. `BUDGET_CONFIRMATION_REQUIRED` (soft limit) and `UNKNOWN_COST_NOT_ACCEPTED` are not offered either. The double-charge prompt depends on the message containing `acceptPossibleDoubleCharge`. |
| Reuse successful artifacts        | **IMPLEMENTED**                                                 | Execution keys (text, images, video, TTS, renders) and `reused: true`; resume skips `superseded`.                                                                                                                                                                                                                                                                                                                                                                                          |
| Avoid duplicate provider calls    | **IMPLEMENTED** (video), **PARTIALLY IMPLEMENTED** (sync calls) | BullMQ id = job id; `active_key`; video never resubmitted. Synchronous image, TTS and LLM calls that time out (`TIMEOUT`, outcome `unknown`) are **retried** as transient (`errors.ts`, `generation-processor.ts:767`), so a paid call can run twice. This is bounded by 3 attempts and reservations, but `KNOWN_LIMITATIONS.md` mentions only video.                                                                                                                                      |
| Recovery after worker restart     | **IMPLEMENTED**                                                 | `Reconciler.run` (queued, running, lost polls; `WORKER_LOST`); `queue.integration.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                |
| Unknown submission outcomes       | **IMPLEMENTED**                                                 | `SUBMIT_OUTCOME_UNKNOWN`, held reservations with owner settle/release in the Operations UI, explicit double-charge consent on resume.                                                                                                                                                                                                                                                                                                                                                      |
| Cancel                            | **PARTIALLY IMPLEMENTED**                                       | API and tests exist; **no cancel control in the web app**.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## B4. Audio Configuration

| Requirement                  | Status                          | Evidence                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice-over configuration     | **IMPLEMENTED**                 | Voice profiles (model, voice, language, speed, instructions), snapshotted per job; per-scene selection.                                                                                                                                       |
| Background music             | **PARTIALLY IMPLEMENTED**       | One track for the whole video, looped, one volume; approval is required but not possible in the UI (B2).                                                                                                                                      |
| Sound effects                | **MISSING**                     | No `purpose=sfx`, no timeline placement, no render input.                                                                                                                                                                                     |
| Enable/disable each layer    | **PARTIALLY IMPLEMENTED**       | Music is optional. Voice-over cannot be turned off for a scene with narration (`VOICEOVERS_INCOMPLETE`). Native clip audio cannot be enabled in the render.                                                                                   |
| Per-scene audio              | **PARTIALLY IMPLEMENTED**       | Voice-over per scene only; no per-scene music level, mute or SFX.                                                                                                                                                                             |
| Volume and mixing controls   | **PARTIALLY IMPLEMENTED**       | Music volume only. Ducking threshold and ratio, fade length, voice gain and loudness target are fixed in code.                                                                                                                                |
| Timing and synchronization   | **PARTIALLY IMPLEMENTED**       | The voice-over starts at the scene start and is padded to the scene end; there is no offset. Caption timing is proportional. Overruns block the render.                                                                                       |
| Reuse existing audio assets  | **IMPLEMENTED**                 | Library uploads (`purpose` voiceover or music) are offered in the voice-over tab and the render panel.                                                                                                                                        |
| Manifest and reproducibility | **IMPLEMENTED** for what exists | Manifest + settings + `RENDERER_VERSION` → `renderExecutionKey`. Any new audio parameter must enter the manifest or settings, or reuse would return a render made with other settings.                                                        |
| Cost estimation and budget   | **IMPLEMENTED** (TTS)           | TTS estimates and reservations; music and mixing cost nothing. **Risk:** `generateAudio: true` on clips is priced (variants such as `720p` vs `720p-silent`) but the audio is discarded by `-an`. The web never sends it; the API accepts it. |

---

# C. Proposed architecture (minimum changes)

## C1. P1: OpenRouter Settings UI

**Credential decision:** keep `OPENROUTER_API_KEY` in the server environment
(`.env` / `infra/deploy/.env.production`, mode 600). Do **not** accept, store or echo the key
through the UI or PostgreSQL. Reasons:

- Storing it in the database would add encryption and key management, put a secret in backups
  (`ADR-0020` dumps contain the whole database) and widen what `acf_app` can read.
- Adapters are built once at startup in two processes (API and worker). Hot-swapping keys would
  need new cross-process invalidation: speculative architecture.
- The UI instead shows **configured / not configured** and offers **Test connection**. Rotating the
  key stays an operator task (edit the env file, `./acf.sh up -d api worker`), which the UI
  explains in one line.

**Authorization:** add a **platform operator** notion before any registry write over HTTP, because
the registry and routes are global. Minimum compatible option: an env allowlist
(`OPERATOR_EMAILS`), checked in a guard, with no schema change. Alternative: a `users.is_operator`
column (migration). The env allowlist is recommended for P1; revisit if multi-tenant work starts.
Reads stay available to every signed-in user, as today.

| Layer                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend                      | New "AI providers & models" section on `settings/page.tsx` (operators edit; others read): provider card (configured flag, status, Test connection with remaining credit and usage), model table per capability (status, tier, limits, active prices, price source and date), route table (task → model, with a picker showing only enabled models of enabled, configured providers that have the capability). Reuse `QueryFilters`, `Pill`, `LocalTime`, `formatUsd`, the existing `ModelSelect` pattern. |
| API (new endpoints, additive) | `GET /ai/routes`; operator-only `PUT /ai/routes/:task`, `PATCH /ai/providers/:key` (status), `PATCH /ai/models/:id` (status, optional schema mode), `POST /ai/providers/:key/test`. No change to existing endpoints.                                                                                                                                                                                                                                                                                      |
| Services                      | Make `RegistryAdminService` a Nest provider (constructor already takes `PrismaClient`) and call the same methods the CLI uses. Fix `RegistryService.isConfigured` to check every capability map. Add `checkKey()` to the OpenRouter adapter config (free `GET /key`), behind a provider-agnostic `ProviderHealth` result.                                                                                                                                                                                 |
| Database                      | Optional `ai_registry_events` (append-only audit: actor, action, before, after), the same pattern as `provider_circuit_events`. Recommended for traceability; it is the only migration in P1.                                                                                                                                                                                                                                                                                                             |
| Worker                        | None. Routes and statuses are read from PostgreSQL per job already.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Not in UI                     | Price editing and catalog imports stay CLI (they write append-only, sourced data); paid smoke tests stay CLI (`ACF_PAID_SMOKE`).                                                                                                                                                                                                                                                                                                                                                                          |
| Tests                         | Contract test for `GET /key` with a fixture; integration tests (operator vs owner vs viewer; the key never appears in any response or log; route to a model without the capability refused); permission-matrix rows for the new routes; E2E: an operator changes a route and the picker default follows it.                                                                                                                                                                                               |

**Reuse without modification:** `RegistryService` reads, `setRoute`, `setProviderStatus`,
`setModelStatus`, `setSchemaMode`, `filterCandidates`, `ModelCatalog`, env validation, CLI.

## C2. P2: Asset Library

| Layer    | Change                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend | (a) Approve, reject, edit label and archive in `LineagePanel` (`/assets/:id/approve                                                                                                                                                                                                                                                                                                                                         | reject`exists). (b) A shared`AssetPicker`(modal over the Library list, filtered by type and purpose) used by: brief forms (character, environment), a new scene "References" field in the scene editor, the voice-over tab and the music select. Selection only; uploads stay in the Library. (c) Character and environment pages (list, versions, attach references, approve) on the existing brand API. (d) Collections UI (filter and add-to-collection). (e) Server-side paging and search instead of`apiGetAll`. |
| API      | Existing endpoints cover (a)–(c). New and additive: `GET /projects/:id/assets` gains optional `purpose`, `q` and `collectionId` filters (additive query params); collection CRUD and membership endpoints; `GET /assets/:id/lineage` gains `asset_inputs` edges in a new optional field, and `usages` adds keyframe, clip, voice-over, scene reference and render uses in a new optional field (existing fields unchanged). |
| Services | `AssetsService.update` merges user metadata and **refuses changes to system keys** (`purpose`, `audio`, `clipHash`, other probe fields). Better: move system-owned fields out of the mutable JSON (see Database). `AssetsService.lineage` and `usages` read `asset_inputs` and the selection tables.                                                                                                                        |
| Database | Collections: `asset_collections` (project-scoped, archive-only) + `asset_collection_items` (collection_id, asset_id, added_by, added_at; composite FKs on `(project_id, id)`). Membership is organizational only: **never** used as a production input, so history cannot depend on it. Optional: an immutable `assets.purpose` column, backfilled from `metadata.purpose`, guarded by the `AC005` trigger.                 |
| Worker   | None. Bindings are already recorded.                                                                                                                                                                                                                                                                                                                                                                                        |
| Tests    | Integration: metadata system keys cannot change; collections are project-isolated; archiving an asset in a collection is still blocked only by production use (`AC008`); lineage includes `asset_inputs`. Database: trigger coverage for any new immutable column (`schema-objects` test). E2E: upload music → approve in Library → pick in render; pick a character in a brief → storyboard scenes pin its version.        |

**Reuse without modification:** upload pipeline, write-once store, `asset_inputs`, selection
tables and triggers, render manifest, brand API, `ImagesService.review`, `MediaPreview`.

## C3. P3: Worker Monitoring & Smart Recovery

No backend redesign. Mostly UI, plus one contract-preserving fix.

| Layer    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend | (a) `ResumeRunButton`: handle `ESTIMATE_CHANGED`, `BUDGET_CONFIRMATION_REQUIRED`, `UNKNOWN_COST_NOT_ACCEPTED` and `NOTHING_TO_RESUME` by **error code and `error.current`**, not message text; show the estimate and resend with `confirmedEstimateUsd` / `acceptOverBudget` / `acceptUnknownCost` / `acceptPossibleDoubleCharge` (all already in the resume request schema). (b) A compact "Activity" panel per content item: latest job per stage and scene, status pill, attempt, readable error, and an expandable row with `events` from `GET /generation-jobs/:id`. (c) Cancel button on running runs (with the existing "provider may still charge" text for submitted clips). (d) Complete `jobErrorText` for all job codes and group them as retryable / needs action / possibly charged. |
| API      | Optional additive endpoint `GET /content/:id/jobs` (latest jobs with events), so the panel needs no N+1 calls. No change to existing endpoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Services | None required. Optional: expose each job's error class (retryable, needs action, possibly charged) as a derived DTO field, computed from the existing policy table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Worker   | **Decision needed, not a default:** should synchronous calls whose outcome is `unknown` (timeouts) be retried automatically? Options: keep the policy and document it in `KNOWN_LIMITATIONS.md`; or hold the reservation and require consent, as for video. Changing it touches `generation-processor.ts` and `media-jobs.ts` retry branches.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Database | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tests    | E2E: a failed clip run resumed from the UI after confirming the estimate; cancel from the UI; event history visible. Unit tests for the error-code-to-action mapping. API integration test: resume of a video job with and without `confirmedEstimateUsd` (not covered today).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Reuse without modification:** `Reconciler`, `ResumeService`, circuits, `job-store`,
execution keys, held-reservation flow, Operations page, `/generation-jobs/:id` (events already
returned).

## C4. P4: Audio Configuration

Extend the existing render; do not add an audio service or change TTS.

| Layer    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain   | Add an `audio` block to `renderManifestSchema` (inputs) and `renderSettingsSchema` (mix): layers `voice` (enabled, gainDb), `music` (existing, plus fadeIn/fadeOut, ducking on/off and amount), `clipAudio` (enabled, gainDb), `sfx[]` (assetId, sceneId, offsetMs, gainDb); per-scene overrides (mute music, voice offset). Bump `RENDERER_VERSION` (`render.v2`) so `renderExecutionKey` never reuses a render made with other settings. Old renders keep `render.v1`; the parser must accept both. |
| Media    | `renderVideo`: optional clip-audio path (drop `-an` only when enabled), `adelay` for SFX and offsets, `volume` per layer, configurable ducking and fades. The graph is still built with safe arguments. Extend `selftest.ts` with an SFX and clip-audio case.                                                                                                                                                                                                                                         |
| API      | `createRenderRequestSchema` gains optional `audio` (additive; omitted = today's behaviour). `render-plan` lists `sfxOptions` (approved uploads with `purpose=sfx`) and reports whether each clip has an audio stream. The upload `purpose` enum gains `sfx` (additive). Relax `VOICEOVERS_INCOMPLETE` only when the request explicitly turns the voice layer off.                                                                                                                                     |
| Services | `RendersService` validates the SFX/music assets (approved, project, purpose, stored file) and records them in the manifest; the worker's `render-jobs.ts` writes `asset_inputs` (role `music` exists; SFX needs a new role or reuses `music` — prefer a new `sfx` role).                                                                                                                                                                                                                              |
| Database | Only if a new `asset_inputs.role` value `sfx` is chosen: an enum migration (own migration, PostgreSQL rule). No new tables.                                                                                                                                                                                                                                                                                                                                                                           |
| Frontend | "Audio" section in `render-panel.tsx`: layer toggles, gain sliders, ducking, fades, SFX list with scene and offset; per-scene mute/offset in a collapsible table.                                                                                                                                                                                                                                                                                                                                     |
| Cost     | Mixing stays free. Warn, or refuse in the API, when `generateAudio: true` clips exist but the clip-audio layer is off; or add clip audio as a layer so paid audio is usable. TTS budgeting is unchanged.                                                                                                                                                                                                                                                                                              |
| Tests    | Unit: manifest/settings parse v1 and v2; execution key changes with any audio parameter. Media: filter-graph tests per layer; QC loudness still within target with all layers. Integration: SFX must be approved and of the project; renders with `audio` omitted are byte-for-byte the same settings as today. E2E: render with music, SFX and a muted scene.                                                                                                                                        |

**Reuse without modification:** voice profiles, TTS jobs and estimates, per-scene voice-over
selection, audio upload and FFprobe validation, loudness two-pass, captions, QC, export package.

---

# D. Implementation plan

## Shared dependencies

| Dependency                                                   | Needed by                                           | Notes                                                    |
| ------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------- |
| Platform operator authorization                              | P1 (required), P3 (optional: circuit control in UI) | Build once in P1.                                        |
| `AssetPicker` component and `purpose`-filtered asset listing | P2, P4 (SFX and music pickers)                      | Build in P2; P4 consumes it.                             |
| Library approve/reject UI                                    | P2, P4 (music and SFX must be approved)             | P2 first step.                                           |
| Asset metadata immutability (`purpose`)                      | P2, P4 (eligibility of music and SFX)               | Must land before P4 relies on `purpose=sfx`.             |
| Job error-code catalogue in the web (`jobErrorText`)         | P3, P4 (render errors)                              | P3.                                                      |
| Additive contract discipline                                 | All                                                 | New optional fields only; existing clients keep working. |

## P1: OpenRouter Settings UI

- **Scope:** read-only provider, model, price and route views for everyone; operator-only
  enable/disable, routes, schema mode, test connection; key status without the key itself.
- **Dependencies:** none (introduces operator authorization).
- **Sequence:**
  1. Operator guard (`OPERATOR_EMAILS`), permission-matrix rows.
  2. `isConfigured` covers all capabilities; `GET /ai/routes`.
  3. Read-only Settings section (providers, models, prices, routes).
  4. `RegistryAdminService` as a Nest provider; write endpoints; optional `ai_registry_events`.
  5. `checkKey` (`GET /key`) with a contract fixture; Test connection button.
  6. Pickers hide models of disabled or unconfigured providers.
- **Acceptance:** an operator changes a route and the next generation uses it; non-operators get
  `403` on writes; no response, log or HTML contains the key (test); Test connection reports
  configured / rejected / unreachable without a paid call; every change is attributable.
- **Risks:** a global change affects all projects mid-flight (jobs already queued keep their model
  because it is persisted on the job; document that); operators may expect to paste a key (explain
  the env procedure); `GET /key` fields may change (contract test, verification record update).
- **Complexity:** medium.

## P2: Asset Library

- **Scope:** Library review actions, metadata integrity, complete lineage and usages, a reusable
  picker, character and environment UI, brief and scene reference selection, collections,
  server-side paging.
- **Dependencies:** none. P4 depends on steps 1–2.
- **Sequence:**
  1. Approve/reject/label/archive in the Library (UI only).
  2. Protect system metadata keys (service rule; optional immutable `purpose` column).
  3. Lineage and usages include `asset_inputs` and selections (additive fields).
  4. Server-side filters (`purpose`, `q`) and paging in the Library page.
  5. `AssetPicker`; character and environment pages; brief character/environment fields.
  6. Scene "References" in the scene editor (new storyboard version, as today).
  7. Collections (migration, API, UI).
- **Acceptance:** an uploaded music file can be approved and used without the API; system metadata
  cannot change through `PATCH`; a generated clip shows its keyframe as input; selections are
  stored as asset IDs and a later master change does not alter an existing storyboard; collections
  never affect generation inputs; no stage gains an upload control.
- **Risks:** backfilling an immutable `purpose` column for existing uploads; the picker must
  respect project isolation (`404` for other projects); the character UI touches the M1 approval
  protocol (reuse the API with `If-Match`; do not add shortcuts).
- **Complexity:** high (largest package; can ship in the slices above).

## P3: Worker Monitoring & Smart Recovery

- **Scope:** fix resume confirmations, add cancel, an activity panel with job events, a complete
  error catalogue; decide the sync-timeout retry policy.
- **Dependencies:** none.
- **Sequence:**
  1. `ResumeRunButton` confirmation flow by error code (`ESTIMATE_CHANGED`, soft budget, unknown
     cost, double charge) + API integration test for video resume.
  2. Cancel control.
  3. `jobErrorText` for every code, grouped by action.
  4. Activity panel with expandable events (optional `GET /content/:id/jobs`).
  5. Owner decision on retrying unknown-outcome sync calls; implement or document.
- **Acceptance:** a failed clip run resumes from the UI after confirming the shown estimate; no
  resume path can submit a video twice without explicit consent; users can cancel a run and see
  why each job failed and what to do; no new provider calls happen for reused results.
- **Risks:** low; mostly UI. A policy change for sync timeouts touches retry code that is
  covered by integration tests (`processor`, `media-processor`).
- **Complexity:** low–medium.

## P4: Audio Configuration

- **Scope:** layer toggles and gains, music fades and ducking control, clip audio, SFX with scene
  offsets, per-scene mute/offset; all recorded in the render manifest and settings.
- **Dependencies:** P2 steps 1–2 (approval UI, immutable `purpose`), `AssetPicker` (P2 step 5).
- **Sequence:**
  1. Domain: v2 manifest/settings with defaults equal to today; `RENDERER_VERSION` bump; v1
     parsing kept.
  2. Media: filter graph per layer; self-test cases.
  3. API: optional `audio` in the render request; `sfx` purpose; plan options; voice-layer rule.
  4. Worker: pass the new inputs; `asset_inputs` for SFX.
  5. UI: Audio section in the render panel.
  6. Clip-audio cost guard (warn or refuse paid audio that would be discarded).
- **Acceptance:** a render without `audio` is identical in settings and output spec to today;
  every audio parameter is in the manifest or settings and changes the execution key; QC passes
  (−14 LUFS ±1, true peak ≤ −1 dB) with all layers; SFX and music must be approved project uploads
  with a licence note; an exported manifest reproduces the mix.
- **Risks:** FFmpeg graph complexity on Debian FFmpeg 5.1 (run `media:selftest` in the image);
  caption and timing interactions with voice offsets; render time growth; per-scene overrides can
  bloat the UI (keep them collapsed).
- **Complexity:** medium–high.

---

# E. Recommendations

**Order: P3 → P2 (steps 1–3) → P1 → P2 (steps 4–7) → P4.**

1. **P3 first.** It fixes recovery paths that fail today (clip resume, soft-budget and
   unknown-cost confirmations, no cancel) without schema changes. It directly protects cost
   control and reliability, and it is the smallest package.
2. **P2 integrity steps next** (Library approval, protected system metadata, complete lineage).
   They close a data-integrity gap (`PATCH` can change `purpose`), unblock the music workflow that
   the UI currently cannot finish, and are prerequisites for P4.
3. **P1 after that.** It is valuable but touches global configuration, so it needs the operator
   authorization decision first. Keeping the key in the environment avoids new secret-storage
   risk.
4. **P2 feature steps** (picker, brand UI, references, collections). These add the largest UI
   surface; doing them after the integrity fixes means every new selection path is built on
   protected data.
5. **P4 last.** It depends on P2 and changes the render manifest and settings version; it should
   start only when the asset rules it relies on are in place.

Owner decisions needed before implementation:

- Operator model for P1: env allowlist (recommended) or a `users` column.
- Whether timed-out synchronous paid calls may be retried automatically (P3 step 5).
- Collections scope: per project (recommended, matches isolation) or cross-project.
- Clip audio: add it as a render layer, or refuse `generateAudio: true` (P4 step 6).
- Whether these packages follow the existing process (a design review package per package before
  coding), as M1–M8.5 did. Recommended.
