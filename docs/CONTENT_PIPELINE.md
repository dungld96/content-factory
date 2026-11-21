# Content Production Pipeline

How one brief becomes one approved vertical video. Rules live in `packages/content-domain`.

## 1. Overview

| Step | Output | Gate (human) |
|---|---|---|
| 1. Brief | Validated brief | — |
| 2. Script | Script version (includes the content plan) | **Gate 1**: approve a script |
| 3. Storyboard | Storyboard version with scenes | **Gate 2**: approve a storyboard |
| 4. Keyframes | 1–4 image candidates per scene | **Gate 3**: every scene has a keyframe |
| 5. Clips and voice-overs | Video clip and voice-over candidates per scene | **Gate 4**: every scene has a clip and a voice-over |
| 6. Render | Final MP4, SRT, thumbnail, QC report | **Gate 5**: approve the render |
| 7. Export | Downloadable package | — |

Gates are recorded as pointers on the content item (`approved_script_version_id`,
`approved_storyboard_version_id`, `approved_render_id`) and as selection tables
(`scene_keyframes`, `scene_clips`, `scene_voiceovers`). Expensive media generation starts only
after gate 2 (ADR-0005).

## 2. Content status

The status shows where the item is. Approving a script or storyboard does not change it; the
gate pointers do.

```text
draft → scripting → script_review → storyboarding → storyboard_review
      → generating_assets → asset_review → rendering → quality_review → approved → exported
```

- `needs_input`: the brief is invalid.
- A job that fails or is canceled returns the item to the status it started from.
- A rejected render returns to `asset_review`.
- Scripts can be regenerated from `draft`, `needs_input`, `script_review`, `storyboard_review`
  or `asset_review`. Scene media and renders can be redone after review, approval or export.
- `researching`, `planning`, `failed` and `canceled` exist in the enum but no step uses them yet.

## 3. Steps

### 3.1 Brief

A brief lives on a **content master** and is copied into each **variant** (content item); the
pipeline always runs on the variant's copy (ADR-0015). Fields: `topic` (required), `audience`,
`objective`, `tone`, `callToAction`, `notes`, up to 20 `sourceUrls`; plus the item's format
(`short_video` only), duration, aspect ratio and language.

Validation is deterministic (no LLM): errors block generation; warnings, claim flags and platform
limits are advisory. There is no research step: the script may cite only the brief's source URLs.

### 3.2 Script

A `script_generation` job writes the script and its content plan (angle, hook, key message,
CTA). Output is checked against `scriptContentSchema` and the script rules; an invalid output
gets **one repair call**, then fails with `OUTPUT_INVALID`. Every edit creates a new immutable
version.

### 3.3 Storyboard

Generated only from the approved script. Each scene has: number, duration, shot type, camera
angle and movement, character action, character/environment versions, visual description,
image prompt, video prompt, negative prompt, voice-over segment, on-screen text, reference
assets and acceptance checks.

Rules:
- Scene durations sum to the target within max(1 s, 5 %).
- Generated scenes use the routed clip model's lengths (for Veo 3.1 Lite: 4, 6 or 8 s) and the
  voice profile's narration pace (template `storyboard.v2`). Hand-edited scenes may use any length.
- A storyboard whose script is no longer the approved one is **stale** and cannot be approved.
- Editing a scene creates a new storyboard version.

### 3.4 Keyframes

One `image_generation` job per scene, 1–4 candidates. The prompt is built from the scene without
an LLM call (template `image.v1`). References sent: the character master's primary asset, the
environment master's primary asset, then the scene's reference assets. Each image is validated
(magic bytes, type, dimensions), stored, and linked to its job, scene and inputs. The user
approves candidates and picks one keyframe per scene. Unchanged scenes of a newer storyboard
version reuse their keyframe.

### 3.5 Clips and voice-overs

- **Clip**: one `video_generation` job per scene, starting from its keyframe. Asynchronous:
  submit → poll (followed up to 6 h) → download → FFprobe validation. The requested length is the
  smallest supported duration that covers the scene.
- **Voice-over**: one `tts_generation` job per scene with narration text, using the content
  item's **voice profile** (model, voice, language, speed). A voice-over longer than its scene is
  flagged. Users can also upload a voice-over.
- Clip generation needs the estimate to be confirmed (`confirmedEstimateUsd`).

### 3.6 Render

A `render` job (FFmpeg in the worker, no provider cost) assembles the chosen clip and voice-over
of every scene:

- 1080×1920, 30 fps, H.264/AAC, hard cuts;
- captions from the voice-over text (burned in and SRT), split at phrases; cue timing is
  proportional to text length;
- optional uploaded music (with licence note), ducked under the voice;
- loudness normalized to −14 LUFS;
- thumbnail from scene 1's keyframe.

Optional audio layers (P4, renderer `render.v2`): voice-over on/off and level, a voice offset per
scene, the clips' own audio, music fades, ducking on/off and mute per scene, and sound effects
(approved Library uploads with a licence note) placed in a scene. Without them the render is the
mix above, and an identical earlier render is reused.

The render's inputs, audio layers and settings are frozen in its manifest.

### 3.7 Quality control

Automated after every render (FFprobe, `blackdetect`, `freezedetect`, `silencedetect`,
`ebur128`): readable file, dimensions, duration, audio present, valid subtitles, no missing scene,
black/frozen/silent stretches. Errors fail the render; warnings name the scene.

Human checklist at gate 5: character identity, brand consistency, factual correctness, visual
defects, audio quality, platform suitability.

### 3.8 Export

Export marks the approved render as exported. The package is downloaded file by file: MP4, SRT,
thumbnail, manifest (inputs, models, settings, QC, checksums, approved script) and cost report.
Nothing is published to social platforms.

## 4. Reuse and resume

- Every job has an **execution key**: a hash of the content version, stage, scene, input
  asset/version IDs, prompt template and model configuration. Identical inputs reuse the earlier
  result (no new cost) unless the user asks to regenerate.
- Each scene is retried on its own; completed scenes are never redone.
- **Resume** on a failed run re-requests each failed or canceled job in one new run, through the
  normal planning and budget checks.
- Every job stores its fully resolved prompt snapshot. Prompt templates are versioned files
  (`packages/content-domain/src/prompts`).

## 5. Pilot format

One 30 s vertical video, 3–6 scenes, one character and environment profile, one image
candidate per scene to start. The M8 pilot cost about USD 1.06 (`docs/design/m8/pilot-report.md`).
