# P3d Design Review Package — Keep paid media when a later step fails

- Status: **Revision 1, approved by the owner (2026-11-21)**: R1–R8 as recommended. Slices in
  progress; deviations in §12.
- Extends: `docs/design/P3-design-review-package.md` (W1–W6, approved). P3d is its second
  revision: it does not change W1–W6.
- Input: the owner's local test (Issue #03 of the post-MVP review): a clip was generated and paid
  for, FFprobe was not installed, the job failed, and the only way forward was to pay for the clip
  again. Owner rule: _once an expensive artifact has been generated, never generate it again
  only because a later step failed._

## 0. Findings (verified in the code, 2026-11-21)

| #   | Finding                                                                                                                                                                                                                                                    | Evidence                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| F1  | A completed clip is downloaded to a **temporary file**, checked with FFprobe, and only then stored. When FFprobe is missing the job ends `MEDIA_TOOLS_MISSING` and the temporary file is deleted                                                           | `apps/worker/src/media-jobs.ts` `terminal()` (download → `inspectVideoFile` → store)              |
| F2  | The same failure marks the clip's invocation `outcome_unknown` with **no cost**, and `MEDIA_TOOLS_MISSING` **releases** the reservation. The clip was delivered and charged, but the budget counts it as USD 0 ("unknown cost is not zero cost" is broken) | `generation-processor.ts` `poll()` → `videos.abandon`; `budget-ledger.ts` `reservationOutcomeFor` |
| F3  | Resume of that job calls `VideosService.generate` again: a **new paid submission**. The provider job id of the delivered clip is kept on the failed job but never used again                                                                               | `apps/api/src/generation/resume.service.ts` `requestAgain` (`video_generation`)                   |
| F4  | Voice-overs behave the same way: `synthesize` (paid, recorded) → `inspectAudio` → store. A missing FFprobe ends the job; the audio bytes are lost; Resume pays again                                                                                       | `media-jobs.ts` `runTts()`                                                                        |
| F5  | A storage outage after a paid TTS call (`STORAGE_UNAVAILABLE`, retryable) retries the **whole job**, so the call is paid again on each attempt                                                                                                             | `generation-processor.ts` `handleError` (retryable branch)                                        |
| F6  | A clip that fails validation (`OUTPUT_INVALID`) is recorded `failed` with no cost unless the provider reported one, although it was delivered                                                                                                              | `media-service.ts` `fail()`                                                                       |
| F7  | Nothing checks for FFmpeg/FFprobe **before** a paid media call. The worker starts without them, and the gap shows up only after the provider has been paid. There is no Windows setup guide                                                                | `apps/worker/src/main.ts`; `docs/LOCAL_DEVELOPMENT.md`                                            |
| F8  | There is no way to see a delivered clip or voice-over that failed a later step (nothing was stored)                                                                                                                                                        | —                                                                                                 |

Images are not affected: `inspectImage` is pure TypeScript (no FFprobe), and the image path
already stores before it succeeds. Renders are not affected: they call no provider, so Resume is
free.

## 1. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                                                                                                                        | Fixes      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R1  | **Stage before validating.** As soon as a clip is downloaded or a voice-over is synthesized, its bytes go to object storage under `staging/` and the job records the key, size, checksum and the type read from the file's first bytes. Only then FFprobe runs                                                                                | F1, F4, F8 |
| R2  | **Record the cost when the output is delivered**, not when it is validated: a completed clip's invocation is `succeeded` with its reported or estimated cost before FFprobe runs. A failure after delivery **settles** the reservation (the charge is in the ledger)                                                                          | F2, F6     |
| R3  | **Finish instead of regenerate.** A scene job that failed **after delivery for a reason outside the output** (`MEDIA_TOOLS_MISSING`, `STORAGE_UNAVAILABLE`, `WORKER_LOST` after staging) ends with `deliveredAt` set. Resume creates a _finish_ job that validates and stores the staged file: **no provider call, no cost, no confirmation** | F3         |
| R4  | **Clips can also finish from the provider.** If staging itself failed (storage down), the finish job downloads the clip again from the provider job (a free status/content read) while `providerExpiresAt` allows it                                                                                                                          | F3         |
| R5  | **Storage retries in place.** After a paid TTS call, the worker retries the storage write in the same attempt (3 tries, 1 s / 4 s / 16 s, jitter) instead of retrying the job. If storage is still down the job ends `OUTPUT_NOT_STORED` (_Possibly charged_ group, known cost): resuming it pays again and needs the double-charge consent   | F5         |
| R6  | **Check tools before paying.** The worker probes `ffmpeg -version` and `ffprobe -version` at start and every 5 minutes. A clip or TTS job is refused **before** its paid call with `MEDIA_TOOLS_MISSING` while the tools are missing (reservation released, nothing charged). The worker logs one clear start-up error                        | F7         |
| R7  | **Preview the delivered file.** `GET /generation-jobs/:jobId/delivered-output` (viewer) streams the staged file; the scene's failure line shows _Preview_ and _Finish (no new charge)_                                                                                                                                                        | F8         |
| R8  | **Windows guide.** `docs/LOCAL_DEVELOPMENT.md` gains "Windows (pnpm dev, no Docker for the apps)": install FFmpeg (`winget install Gyan.FFmpeg`), set `FFMPEG_PATH` / `FFPROBE_PATH` when not on `PATH`, check with `pnpm media:selftest`; PostgreSQL, Redis and SeaweedFS via Docker Desktop or native installs                              | F7         |

**Out of scope:** changing the reconciler's orphan detection, the retry policy for provider
errors, W5/W6, images and renders, push updates (SSE), and the scene monitor UI (P3e; this package
adds only the two buttons in the existing failure line).

**One migration** (additive: four nullable columns on `generation_jobs`, one CHECK). API changes are
additive: one read endpoint, two optional DTO fields, one error code value, one resume skip reason.

## 2. Acceptance

| Criterion                                                                                                                    | Evidence                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The owner's case**: clip delivered, FFprobe missing → install FFprobe → Resume → clip appears, **one** provider submission | Worker + API integration (mock provider; `tools` stub that throws `MediaToolsMissingError` once): one invocation, finish job succeeds, asset created from the staged bytes (same checksum)   |
| The same for a voice-over                                                                                                    | Worker integration: one TTS call; finish job stores the staged audio                                                                                                                         |
| The budget counts the delivered clip                                                                                         | Unit + integration: invocation `succeeded` with cost before validation; reservation `settled` on `MEDIA_TOOLS_MISSING`                                                                       |
| No paid call while tools are missing                                                                                         | Worker integration: tools missing at start → clip and TTS jobs end `MEDIA_TOOLS_MISSING` with **zero** provider calls, reservation released                                                  |
| Storage outage after TTS does not pay again silently                                                                         | Worker integration: storage fails 3× → `OUTPUT_NOT_STORED`, one TTS call; Resume without consent skips it                                                                                    |
| A delivered file can be previewed before it is finished                                                                      | API integration: viewer gets the bytes with the sniffed type, `nosniff`, Range support; other project → 404; after finishing → 410 `ALREADY_FINISHED` with the asset id                      |
| Finish is safe                                                                                                               | Integration: two concurrent Resumes create one finish job (unique key); a finish job never calls a provider (mock asserts zero calls); invalid staged file → `OUTPUT_INVALID`, no new charge |
| Nothing else changes                                                                                                         | Existing suites pass; image and render paths untouched                                                                                                                                       |
| E2E                                                                                                                          | Clips tab: failure line shows Preview and _Finish (no new charge)_; after finishing, the clip is a candidate                                                                                 |

## 3. Staging (R1)

**Where.** Object key `staging/{projectId}/{jobId}/{attempt}` (no extension: the type is
recorded, not guessed from the name). Same bucket, written with the existing `putIfAbsent` and the
SHA-256 of the bytes. A staged file is **not an asset**: it never appears in the Library, cannot be
selected and is not part of lineage until it is finished.

**Type.** New `sniffMediaType(bytes)` in `@acf/storage` (next to `sniffImageType`) reads the first
bytes: MP4/MOV (`ftyp` box), WebM/Matroska (`1A 45 DF A3`), MP3 (`ID3` or an MPEG frame sync), WAV
(`RIFF…WAVE`), Ogg (`OggS`), FLAC (`fLaC`). Unknown → `application/octet-stream` (the preview
refuses it; finishing still runs FFprobe).

**Columns** (`generation_jobs`, all nullable; migration `p3d_delivered_output`):

| Column                | Meaning                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `delivered_at`        | The paid output was received (download finished or TTS returned)                                                                       |
| `staged_object_key`   | Where the bytes are; null if staging failed (clips can still finish from the provider, R4)                                             |
| `staged_sha256`       | Checksum of the staged bytes                                                                                                           |
| `staged_mime_type`    | From `sniffMediaType`                                                                                                                  |
| `recover_from_job_id` | On a finish job: the failed job whose output it finishes (FK `(project_id, id)`, CHECK: only for `video_generation`, `tts_generation`) |

Staging is written in the same step that records `delivered_at` (database update after the object
write; a crash between them leaves an unreferenced object, removed by the cleanup below).

**Cleanup.** When a finish job stores the asset, the staged object is deleted after the asset
row commits. Staged files of jobs that were not finished are deleted by the reconciler's existing
periodic pass after **14 days** (`STAGED_OUTPUT_RETENTION_DAYS`), and their columns are cleared.
`storage export` and `storage verify` skip `staging/` (temporary files are not backed up).

## 4. Cost at delivery (R2)

- Clips: `videos.complete(invocationId, request, state)` moves from after the asset insert to
  right after the download, before `inspectVideoFile`. An `OUTPUT_INVALID` clip then keeps the
  delivered cost (fixes F6) instead of `videos.fail`'s null cost.
- `MEDIA_TOOLS_MISSING` after delivery no longer calls `videos.abandon` (the outcome is known).
- `reservationOutcomeFor` gains the job: a failed job with `delivered_at` set resolves to
  `settled` (its charge is in the ledger), whatever the code. Without `delivered_at` the current
  rule applies.
- TTS already records the call before validation; only the reservation rule changes.

## 5. Finish jobs (R3, R4)

**Which jobs.** A failed `video_generation` or `tts_generation` job with `delivered_at` set and an
error code in `FINISHABLE_CODES` = {`MEDIA_TOOLS_MISSING`, `STORAGE_UNAVAILABLE`, `WORKER_LOST`}.
`OUTPUT_INVALID` is **not** finishable (the file itself is broken): the user previews it and
regenerates.

**Resume.** `ResumeService.resume` splits the selected jobs: finishable ones get a finish job;
the rest are resumed as today. For a finish job:

- same `kind`, `storyboardSceneId`, `input` and `modelId` as the failed job;
  `recover_from_job_id` set; `idempotencyKey = "finish:{failedJobId}"` (unique: two Resumes create
  one finish job); `maxAttempts` 3;
- **no reservation, no estimate, no confirmation**: it cannot call a provider (the worker's finish
  path has no provider dependency; a unit test asserts it);
- the scene's content status moves as for a normal scene job.

Response: `skipped[]` gains reason `finished_without_charge` for jobs turned into finish jobs
(additive enum value), so the UI can say "Finished from the delivered file: no new charge".

**Worker.** `MediaJobs.finish(job)`:

1. Load the failed job. If `staged_object_key` is set, read the object and verify `staged_sha256`.
   Otherwise (clips only) download from the provider with the failed job's `providerKey` and
   `providerJobId`; if the provider answers 404/410, fail `OUTPUT_EXPIRED` (no charge; the user
   regenerates).
2. Validate exactly as today (`inspectVideoFile` / `inspectAudio`). Tools missing → fail
   `MEDIA_TOOLS_MISSING` again (finishable again, still free).
3. Store as today (`assetObjectKey`, asset row with `generationJobId` = the **failed** job, so
   lineage and cost point at the job that paid), `asset_inputs` as today, `succeedSceneJobIn` for
   the finish job, then delete the staged object.

## 6. Storage retries in place (R5)

`runTts`: after a successful `synthesize`, stage with up to 3 tries (1 s, 4 s, 16 s with ±20 %
jitter) on `STORAGE_UNAVAILABLE`. If all fail: `delivered_at` is set, `staged_object_key` stays
null, and the job ends `OUTPUT_NOT_STORED` (new code; group _Possibly charged_: the charge is known
and recorded, the output is lost). `OUTPUT_NOT_STORED` joins `OUTCOME_UNKNOWN_CODES` for the resume
rule only (needs `acceptPossibleDoubleCharge`), **not** for the reservation (it is `settled`, §4).
Clips keep their bytes on disk during the three tries and can always finish from the provider
(R4), so they end `STORAGE_UNAVAILABLE` (finishable).

## 7. Tool check before paying (R6)

- `@acf/media` gains `checkMediaTools(tools): Promise<{ ffmpeg: string | null; ffprobe: string |
null }>` (version lines, null when missing), reusing `DEFAULT_MEDIA_TOOLS`, `FFMPEG_PATH`,
  `FFPROBE_PATH`.
- Worker start: run it once; log `media_tools_missing` (error) with the paths tried and the doc
  link. Re-check every 5 minutes and before each media job when the last result was "missing"
  (so installing FFmpeg needs no worker restart).
- `submit` of a clip and `runTts` throw `MediaPermanentError('MEDIA_TOOLS_MISSING', …)` **before**
  the paid call while a tool is missing. The reservation is released (nothing was charged).
- Text-only and image jobs are not blocked.

## 8. Preview (R7)

**API.** `GET /generation-jobs/:jobId/delivered-output` (viewer, project-scoped like every job
read). 200 with the staged bytes, `Content-Type` = `staged_mime_type`, `X-Content-Type-Options:
nosniff`, `Content-Disposition: inline`, `Cache-Control: private, no-store`, Range support reused
from `GET /assets/:assetId/content`. 404 when the job has no staged file; 415 when the type is
`application/octet-stream`; 410 `ALREADY_FINISHED` with `current.assetId` once the file was
finished. `generationJobSchema` gains `deliveredAt` and `hasDeliveredOutput` (additive).

**Web.** In the existing job status line of the clips and voice-overs tabs (`scene-clips.tsx`
next to `jobErrorText`, `scene-voiceovers.tsx`) and in the Activity row: when `hasDeliveredOutput`, a **Preview** button
(the existing media modal) and, for finishable codes, **Finish (no new charge)**, which calls the
existing Resume with no consent flags. `MEDIA_TOOLS_MISSING` text becomes "FFmpeg/FFprobe is not
installed on the worker. Install it, then choose Finish: the delivered clip is kept." (`job-errors.ts`).

## 9. Tests

| Level              | Tests                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit               | `sniffMediaType` fixtures (each format, truncated, unknown); `reservationOutcomeFor` with `delivered_at`; finishable-code set; resume split                                                                                                           |
| Worker integration | Owner's case (clip, TTS); tools missing before submit (zero calls); storage down after TTS (`OUTPUT_NOT_STORED`); finish from provider when not staged; expired → `OUTPUT_EXPIRED`; staged checksum mismatch → `OUTPUT_INVALID`; cleanup after finish |
| API integration    | Resume creates one finish job (concurrent requests); no reservation; skip reason; preview endpoint (types, Range, 404/410/415, project isolation); permission matrix row                                                                              |
| Migration          | Columns nullable, CHECK on `recover_from_job_id`, FK                                                                                                                                                                                                  |
| E2E                | Clips tab: failure → Preview → Finish → candidate shown (mock tools that fail once)                                                                                                                                                                   |

All with mock providers and stub tools; no paid calls.

## 10. Implementation plan

| Slice | Content                                                        | Changes                                |
| ----- | -------------------------------------------------------------- | -------------------------------------- |
| P3d-1 | R6 tool check before paying; R8 Windows guide                  | media, worker, docs (no migration)     |
| P3d-2 | R1 staging, R2 cost at delivery, R5 storage retries; migration | storage, database, worker, ai-runtime  |
| P3d-3 | R3/R4 finish jobs; R7 preview endpoint and buttons             | API (additive), contracts, worker, web |

P3d-1 first: it alone prevents the owner's case from costing money (the job is refused before the
paid call), and it ships without a migration.

## 11. Risks

- **More objects in storage.** Each delivered clip is written twice (staging, then the asset).
  Clips are ≤ 200 MB and usually a few MB; staging is deleted on finish and after 14 days.
- **Cost timing.** The clip's cost is recorded a few seconds earlier than today; reports already
  use `started_at`, so nothing moves between periods.
- **A finish job validates a file that is already stored**, so a corrupted staged object is
  detected by the checksum and ends `OUTPUT_INVALID` (no charge).
- **Provider re-download (R4)** depends on the provider keeping the output: `providerExpiresAt`
  is checked first; expired → regenerate (as today).
- **`WORKER_LOST` after staging** is finishable only when `delivered_at` was written; a crash
  between the object write and the update leaves the job as today (reconciler → `WORKER_LOST`,
  not finishable) and the object is cleaned up after 14 days.

## 12. Deviations found during implementation

| Item          | Planned                                                      | Done                                                                                                                                                         | Why                                                                                                                         |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Staging key   | `staging/{project}/{job}/{attempt}`, deleted after finishing | The delivered file is written straight to its **final asset key** under an asset id reserved at delivery (`staged_asset_id`); finishing creates only the row | The object store is write-once with no delete (ADR-0006, `ObjectStore`); no copy, no cleanup pass, nothing to back up twice |
| Cleanup       | Reconciler deletes staged files after 14 days                | None: a delivery that is never finished stays an unreferenced object, like any write-once orphan                                                             | Same as above                                                                                                               |
| Type sniffing | New `sniffMediaType` in `@acf/storage`                       | `sniffContainer` from `@acf/media` (already used by the validators), mapped to the stored type                                                               | No duplicate sniffer                                                                                                        |
| Columns       | four delivery columns                                        | five: `staged_asset_id` added                                                                                                                                | Reserved asset id                                                                                                           |
| Finishable    | `MEDIA_TOOLS_MISSING`, `STORAGE_UNAVAILABLE`, `WORKER_LOST`  | also `INTERNAL_ERROR`: any unexpected error after delivery ends the job (never a retry that pays again) with that code                                       | A TTS retry after delivery would call the provider again                                                                    |
| Resume rule   | `OUTPUT_NOT_STORED` joins `OUTCOME_UNKNOWN_CODES` for resume | New `DOUBLE_CHARGE_CODES` (unknown outcomes + `OUTPUT_NOT_STORED`) for resume; `OUTCOME_UNKNOWN_CODES` still decides held reservations                       | Keeps the two rules separate                                                                                                |
| Unsupported   | —                                                            | A delivered file that is not MP4/MOV/WebM (clip) or MP3/WAV/AAC/M4A (audio) is not stored; the job ends `OUTPUT_INVALID` with its cost recorded              | Nothing usable to keep                                                                                                      |
