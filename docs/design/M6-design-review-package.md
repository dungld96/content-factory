# M6 Design Review Package — Rendering and Export

- Status: **Revision 1, approved by the owner (2026-11-19)**: X1–X12 as proposed (questions 1–5
  answered with the recommended defaults: X3–X7). Implemented in slices M6a–M6d (§15).
- Date: 2026-11-19
- Baseline: M5 approved (`5f9aed6`); ADR-0006 (object storage), ADR-0012 (ledger), ADR-0013
  (jobs), ADR-0016 (keyframes), ADR-0017 (async provider jobs)
- Inputs: IMPLEMENTATION_PLAN §M6, PRD journey C and FR-009/FR-011, CONTENT_PIPELINE stages 9–10
  and §6 (publishing package), API_SPEC §7, M5 package §15 and `docs/design/m5/benchmark-results.md`

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                               | Section |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| X1  | Rendering runs **locally with FFmpeg in the worker** (no paid render service): a new job kind `render` on its own queue (`generation-render`, concurrency 1). No AI call, no provider                                                                | §3      |
| X2  | A **render** is an immutable record of exactly what was assembled (frozen input manifest + settings + outputs). Identical inputs and settings reuse the earlier render (no second encode)                                                            | §4      |
| X3  | Output **1080×1920, 30 fps, H.264 High (CRF 20) + AAC 48 kHz stereo, MP4 faststart**. Lower-resolution clips are **scaled up and labelled** ("upscaled from 720p") in the render's metadata and UI; never described as higher quality (CLAUDE.md §8) | §5.2    |
| X4  | **Captions both burned in and as an SRT file**, from each scene's voice-over text; timing per scene from the measured voice-over duration (no speech recognition in M6)                                                                              | §6      |
| X5  | **Optional background music** per render: an approved `music` upload (licence note required, M5), looped or trimmed, **ducked under the voice** (sidechain), faded out at the end                                                                    | §7      |
| X6  | A voice-over **longer than its scene blocks the render** and names the scene (fix: shorter text or faster voice); never stretched or cut silently                                                                                                    | §5.1    |
| X7  | **Hard cuts** between scenes in M6; transitions later                                                                                                                                                                                                | §5.2    |
| X8  | Loudness normalised to **−14 LUFS integrated, −1 dBTP** (two-pass `loudnorm`), the common target of TikTok/Reels/Shorts                                                                                                                              | §7      |
| X9  | **Automated QC** after every render (FFprobe + `blackdetect`/`freezedetect`/`silencedetect`); hard failures fail the render, the rest are warnings shown to the reviewer                                                                             | §8      |
| X10 | **Gate 5 = human approval of a render** (`content_items.approved_render_id`); status `rendering → quality_review → approved`; **export** marks `exported` and makes the publishing package available                                                 | §9      |
| X11 | Publishing package in M6: MP4, SRT, thumbnail, script, **asset/model manifest** and **cost report** (JSON + human-readable). Social caption and hashtags (an LLM step) move to M8 with publishing                                                    | §10     |
| X12 | A **bundled open-licence font with Vietnamese diacritics** (Be Vietnam Pro, SIL OFL) used for burned-in captions, identical in dev, CI and the deploy image                                                                                          | §6.3    |

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M6):** FFmpeg render worker; media normalisation; subtitle and
audio mix; final MP4; preview and download. Plus what the acceptance needs: QC report, render
approval (gate 5), metadata and cost report, the publishing package files.

**Out of scope:** transitions and effects (later, X7); on-screen text overlays from the
storyboard's `onScreenText` (later, alongside layout templates); word-level caption timing (needs
speech recognition: a `TranscriptionProvider`, later); social caption/hashtags (M8); direct
publishing (post-MVP); multiple output formats per render (16:9/1:1 variants already exist as
separate content items, R0); budgets (M7); GPU/hardware encoding; a paid cloud render service.

**Acceptance (IMPLEMENTATION_PLAN §M6) and evidence:**

| Criterion                                    | Evidence                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid 9:16 MP4 produced from approved scenes | Worker integration test with real FFmpeg on mock clips/voice-overs: 1080×1920, H.264/AAC, duration = Σ scenes ± 0.1 s, every scene present (frame checks at scene boundaries); E2E renders the demo item |
| Metadata and cost report included            | Render detail and `manifest.json`: inputs (assets, models, jobs), settings, FFprobe output, checksum; cost report = the item's ledger (reported/estimated/unknown kept apart)                            |
| Final export has approval state              | Gate 5 pointer enforced by the database (approved render of this item); export refused before approval; status moves to `approved`, then `exported`                                                      |
| (CONTENT_PIPELINE 10) automated checks       | QC report on every render (§8), unit + integration tests per check                                                                                                                                       |

## 2. Where it sits

```
approved storyboard ─ keyframes (gate 3) ─ clips + voice-overs (gate 4) ─┐
                                              optional music upload ───────┤
                                                                           ▼
 API: plan/preflight → render intent (job + render row) ──► worker: render queue
   download inputs → normalise each scene → concat → captions → audio mix → loudnorm
   → encode → FFprobe + QC → store (render MP4, SRT, thumbnail) → render succeeded
                                                                           ▼
 reviewer: preview, QC report, cost → approve (gate 5) → export → publishing package
```

## 3. Render job (X1)

- `generation_job_kind` += `render` (one active render per content item:
  `active_key = {contentItemId}:render`). It reuses the M3 job machinery: intent persisted first,
  `job_events`, bounded retries, DLQ, reconciler, cancel.
- Queue `generation-render`, `WORKER_RENDER_CONCURRENCY` (default 1: CPU-bound on the single
  staging VM, ADR-0014), lock 15 min, FFmpeg timeout `RENDER_TIMEOUT_MS` (default 10 min).
- No `ai_invocations`: rendering has no provider cost. The job records wall time and FFmpeg
  version in its result metadata.
- Retries: infrastructure errors (storage, a killed process) retry like other jobs; a failed QC or
  invalid input does not (same inputs, same result).
- FFmpeg is called with argument arrays via `execFile` (no shell); every text that reaches a
  filter (captions) goes through a file, never through the command line (CLAUDE.md §8).

## 4. Render record and reuse (X2)

New table `renders` (append-only except review/export fields):

| Column                                                                              | Purpose                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `project_id`, `content_item_id`, `storyboard_version_id`, `generation_job_id` | Lineage                                                                                                                                                                                           |
| `manifest` (JSONB, frozen at creation)                                              | Per scene, in order: scene id/number/duration, clip asset id, voice-over asset id (or none), keyframe asset id; music asset id and volume; caption settings; the source models/jobs of each asset |
| `settings` (JSONB)                                                                  | Output spec (X3), caption style, loudness target, font                                                                                                                                            |
| `execution_key`                                                                     | Hash of manifest + settings + renderer version: an identical request reuses a succeeded render                                                                                                    |
| `video_asset_id`, `subtitle_asset_id`, `thumbnail_asset_id`                         | Outputs (assets `render`, `subtitle`, `image`; `generated`, linked to the job; lineage in `asset_inputs` with new roles `clip`, `voiceover`, `music`)                                             |
| `qc` (JSONB)                                                                        | FFprobe summary, checks and warnings (§8)                                                                                                                                                         |
| `upscaled_from`                                                                     | Lowest source resolution when scaling was applied (null = native)                                                                                                                                 |
| `review_status`, `reviewed_by_id`, `reviewed_at`, `review_note`                     | Gate 5 decision                                                                                                                                                                                   |
| `exported_at`, `exported_by_id`                                                     | Export (§9)                                                                                                                                                                                       |

`content_items.approved_render_id` points at the approved render (trigger: same item, succeeded,
approved; new integrity code). Rendering never changes a clip, voice-over or keyframe; a new
render after any change is a new row.

## 5. Timeline and video (X3, X6, X7)

### 5.1 Preflight (API, before the job is created)

For the approved storyboard: every scene has a selected clip (gate 4 clips); every scene with
voice-over text has a selected voice-over (gate 4 voice); **no voice-over is longer than its scene
(X6: 409 `VOICEOVER_EXCEEDS_SCENE` listing the scenes)**; the music asset, if any, is an approved
`music` upload of the project; all files exist in storage; FFmpeg is available. The preflight
result is shown before the user starts the render.

### 5.2 Assembly

Per scene `i` with duration `dᵢ` (from the storyboard):

1. Video: the clip, **trimmed to `dᵢ`**; if the clip is shorter (≤ 10 %, allowed by the M5
   validation), the last frame is held (`tpad`). Scaled to fit 1080×1920 (Lanczos), padded only
   if the aspect differs, `setsar=1`, 30 fps. The clip's own audio is **dropped** (Wan returns a
   track nobody asked for; the voice-over is the narration).
2. Voice: the scene's voice-over placed at the scene start, padded with silence to `dᵢ`; scenes
   without text are silent.
3. Scenes are concatenated with **hard cuts** (X7). Total duration = Σ dᵢ (the content item's
   target ± the storyboard tolerance, already validated in M3).

### 5.3 Encoding

H.264 High, `-crf 20 -preset medium`, `yuv420p`, `+faststart`; AAC 192 kb/s 48 kHz stereo.
Thumbnail: scene 1's keyframe image at 1080×1920 JPEG (an approved, human-chosen frame).

## 6. Captions (X4, X12)

### 6.1 Text and timing

Source: each scene's `voiceOverSegment` (the narration actually spoken). The text is split into
cues of at most 2 lines × 32 characters at word boundaries; cues share the scene's **measured
voice-over duration** in proportion to their characters, starting at the scene start. No speech
recognition in M6, so timing is per cue, not per word — honest about it in the UI ("timed per
sentence").

### 6.2 Outputs

- `captions.srt` (UTF-8, validated by re-parsing) stored as a `subtitle` asset.
- Burned in with the `subtitles` filter from a generated ASS file (style below). Text is escaped
  for ASS (braces, backslashes, line breaks) and written to a file, never interpolated into a
  command.

### 6.3 Style and font

White text, 4 px dark outline, soft shadow, 64 px at 1080 wide, centred at 72 % of the height
(above the platform UI at the bottom). **Be Vietnam Pro** (SIL Open Font License) is bundled in
`packages/media/fonts/` and passed with `fontsdir`, so dev, CI and the deploy image render the
same Vietnamese diacritics; the licence file ships with it. Burn-in can be switched off per
render (SRT only).

## 7. Audio mix (X5, X8)

- Voice track (§5.2) at unity gain.
- Music (optional): an approved `music` upload of the project (licence note recorded, M5),
  looped (`aloop`) or trimmed to the video, base level −18 dB, **ducked** under the voice
  (`sidechaincompress`, threshold −30 dB, ratio 8, attack 20 ms, release 400 ms), 1.5 s fade-out.
  Its licence note is copied into the manifest.
- Master: two-pass `loudnorm` to **−14 LUFS integrated, −1 dBTP, LRA 11**; the measured values
  are stored in the QC report.

## 8. Quality control (X9)

| Check                                                         | Tool                       | On failure                 |
| ------------------------------------------------------------- | -------------------------- | -------------------------- |
| File readable; MP4; H.264 + AAC; 1080×1920; 30 fps            | FFprobe                    | **render fails**           |
| Duration = Σ scenes ± 0.1 s; every scene boundary has a frame | FFprobe, frame at each cut | **render fails**           |
| Audio stream present; integrated loudness −14 ± 1 LUFS        | FFprobe, `ebur128`         | fails / warning            |
| SRT parses; cues within the video; non-overlapping            | parser                     | **render fails**           |
| Black segments > 0.5 s                                        | `blackdetect`              | warning (scene named)      |
| Frozen segments > 1 s (excluding a held last frame)           | `freezedetect`             | warning                    |
| Silence > 2 s where a voice-over is expected                  | `silencedetect`            | warning                    |
| Upscaled sources                                              | manifest                   | label "upscaled from 720p" |

Human checks (CONTENT_PIPELINE 10: identity, brand, facts, defects, audio, platform fit) are the
reviewer's job at gate 5; the UI lists them as a checklist next to the player.

## 9. Statuses, gate 5 and export (X10)

| Event                                                         | Content status                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Render queued                                                 | `asset_review` → `rendering`                                                                                                             |
| Render succeeded                                              | `rendering` → `quality_review`                                                                                                           |
| Render failed or canceled                                     | back to `asset_review` (inputs unchanged; errors shown)                                                                                  |
| Render approved                                               | `quality_review` → `approved` (`approved_render_id` set)                                                                                 |
| Render rejected (note required)                               | `quality_review` → `asset_review`                                                                                                        |
| Export                                                        | `approved` → `exported` (records who/when; the package stays downloadable)                                                               |
| Any upstream change (new keyframe/clip/voice-over/storyboard) | an approved render stays approved for what it contains; a new render is needed to include the change, and approving it moves the pointer |

Permissions: viewers preview renders and download **approved** exports; editors/owners render,
approve, reject and export (like every other gate).

## 10. Publishing package (X11)

Files of an exported render, downloadable separately (no archive dependency in M6):
`video.mp4`, `captions.srt`, `thumbnail.jpg`, `script.txt` (approved script), `manifest.json`
(inputs, models, jobs, prompts' template ids, checksums, settings, QC, licence notes),
`cost-report.json` and a human-readable cost summary in the UI: every AI call of the content item
(including rejected candidates) grouped by stage, reported vs estimated vs **unknown (never shown
as 0)**, plus the subtotal of the assets actually used in this render.

## 11. API (base `/api/v1`)

| Endpoint                                          | Viewer | Editor/Owner | Notes                                                                                  |
| ------------------------------------------------- | :----: | :----------: | -------------------------------------------------------------------------------------- |
| `GET /content/:contentId/render-plan`             |   ✓    |      ✓       | Preflight (§5.1): scenes, inputs, blockers, warnings, upscaling, reuse                 |
| `POST /content/:contentId/renders`                |  403   |     202      | `{ captions: { burnIn }, music?: { assetId, volumeDb? }, regenerate? }` → render + job |
| `GET /content/:contentId/renders`                 |   ✓    |      ✓       | List with status, QC summary, review state                                             |
| `GET /renders/:renderId`                          |   ✓    |      ✓       | Detail: manifest, settings, QC, outputs, job, cost report                              |
| `POST /renders/:renderId/approve`, `/reject`      |  403   |      ✓       | Gate 5; reject needs `{ note }`                                                        |
| `POST /renders/:renderId/export`                  |  403   |      ✓       | Approved renders only; marks `exported`                                                |
| `GET /renders/:renderId/manifest`, `/cost-report` |   ✓    |      ✓       | JSON files of the package                                                              |
| `GET /assets/:assetId/content`                    |   ✓    |      ✓       | Existing (Range): video, SRT, thumbnail                                                |

New error codes: `CLIPS_INCOMPLETE`, `VOICEOVERS_INCOMPLETE`, `VOICEOVER_EXCEEDS_SCENE`,
`MUSIC_INVALID`, `RENDER_IN_PROGRESS`, `RENDER_NOT_APPROVED`, `RENDER_NOT_REVIEWABLE`. All endpoints
join the permission matrix.

## 12. Web UI (M4.5 design system)

- Content workspace: new **Render** tab (stepper "Export" becomes active): preflight checklist
  with blockers linked to the scene/tab that fixes them; options (captions burn-in, music track
  and level); Render button; progress (job stages); the render list.
- Render detail: player (H.264 1080p plays in every target browser), QC report with warnings
  per scene, upscaling label, human-review checklist, cost summary, approve/reject (note), export,
  download links for every package file.
- Asset library: renders and subtitles filterable; lineage shows the render's inputs.
- Pipeline board: `rendering`, `quality_review`, `approved`, `exported` columns already exist.

## 13. Risks

| ID  | Risk                                                   | Mitigation                                                                                                  |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| R1  | CPU/time on the single staging VM                      | Concurrency 1, 10 min timeout, `preset medium` measured in M6a (30 s output); reuse identical renders       |
| R2  | Upscaled 720p looks soft                               | Labelled, never claimed as better; 1080p clip option exists (M5); measured side by side in the M6 demo      |
| R3  | Caption timing drifts within long scenes               | Per-scene windows bound the drift; word timing needs speech recognition (later)                             |
| R4  | Font/diacritic rendering differs between environments  | One bundled font (X12); a golden-frame test renders Vietnamese diacritics                                   |
| R5  | Music licensing                                        | Only approved uploads with a licence note; the note travels in the manifest                                 |
| R6  | Debian FFmpeg 5.1 (deploy) vs 6.1 (dev/CI) differences | M6a checks every filter and option against the deploy image; the version is recorded per render             |
| R7  | Playwright's Chromium cannot decode H.264              | E2E checks the render over HTTP (M5 approach) and plays the SRT/thumbnail; manual browser check in the demo |
| R8  | Large outputs through the API                          | Range streaming (M5a); 30 s at CRF 20 ≈ 15–30 MB                                                            |

## 14. Testing

| Layer               | What                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                | Timeline plan (trim, hold, silence, totals); caption chunking, timing and ASS/SRT escaping; FFmpeg argument building (no shell strings); QC rules; status transitions; execution key/reuse; cost report aggregation |
| Media (real FFmpeg) | Normalise mixed inputs (720p/1080p, 24/30 fps, with/without audio); loudness within ±1 LU; golden frame with Vietnamese diacritics; SRT validity                                                                    |
| DB integration      | Migration, `renders` immutability, gate-5 pointer trigger, `asset_inputs` roles                                                                                                                                     |
| Worker integration  | Real PostgreSQL + Redis + SeaweedFS + FFmpeg: full render, reuse, failure on a missing file, restart mid-render (retry), cancel                                                                                     |
| API integration     | Every endpoint, preflight blockers, permission matrix, gate 5, export                                                                                                                                               |
| E2E (Playwright)    | Demo item: preflight → render → QC report → approve → export → files downloadable                                                                                                                                   |

No paid calls: rendering uses only local FFmpeg; inputs in tests come from the M5 mocks.

## 15. Implementation plan (each slice tested before the next)

| Slice | Scope                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M6a   | `packages/media` render primitives (normalise, concat, captions ASS/SRT, mix, loudnorm, QC), bundled font, deploy-image filter check; media tests |
| M6b   | Migration (`render` job kind, `renders`, gate-5 pointer, asset roles); worker render processor; worker integration tests                          |
| M6c   | API: render plan, render, list/detail, approve/reject, export, manifest and cost report; status transitions; permission matrix                    |
| M6d   | Web: Render tab, render detail, package downloads; E2E; docs (API_SPEC, DATABASE, CONTENT_PIPELINE), ADR-0018                                     |
