# ADR-0018: Local FFmpeg rendering, automated QC and render approval (gate 5)

- Status: Accepted (M6 design package revision 1, approved 2026-11-19; implemented in M6a–M6d)
- Date: 2026-11-19
- Milestone: M6

## Context

M6 turns the approved scene media (keyframes, clips, voice-overs; gates 3–4) into the MVP's
deliverable: an approved, downloadable vertical MP4 with captions, traceable inputs and a cost
report (CLAUDE.md §1). Clips arrive in different sizes and frame rates (720p from the routed
model; 1080p on request), some with unwanted audio; narration is per scene; the staging target is
one small VM (ADR-0014).

## Decision

1. **Render locally with FFmpeg in the worker**, as a `render` job on its own queue (concurrency 1,
   15-minute lock, per-step timeout). No paid render service; rendering records no ledger cost.
   Jobs name a registry model `local/ffmpeg-render` so every job stays traceable to what ran it.
2. **One pipeline, one final encode**: clips normalised to 1080×1920 30 fps (Lanczos, padding,
   last frame held when short, own audio dropped), hard cuts, narration per scene, optional music
   looped and ducked under the voice, two-pass loudness normalisation to −14 LUFS / −1 dBTP,
   captions burned in from a generated ASS file with a bundled open-licence font (Be Vietnam Pro),
   then H.264 High CRF 20 + AAC with faststart. FFmpeg runs with argument arrays; caption text
   only travels through files; work paths are checked before they enter a filter graph.
3. **Frozen, reusable renders**: the `renders` row freezes the manifest (exact assets, durations,
   text, source models, music licence) and settings; identical inputs reuse an earlier render.
   Outputs, QC, review and export are each set once; renders are never deleted.
4. **Automated QC on every render** (FFprobe and FFmpeg detectors): wrong container, codec, size,
   frame rate, duration, silent narration or an invalid SRT fail the render (no retry: same input,
   same result; the report is kept); black, frozen or silent stretches are warnings per scene.
   Upscaled sources are labelled, never described as higher quality (CLAUDE.md §8).
5. **Gate 5 is a human approval of a render** (`content_items.approved_render_id`, enforced by a
   trigger); export marks the item `exported` and makes the package files available (MP4, SRT,
   thumbnail, manifest, cost report). Re-rendering and reworking scene media stay possible after
   approval; the approved render remains what it was until another one is approved.

## Consequences

- No new provider, no new cost, no new data-retention exposure: inputs never leave our storage.
- Rendering is CPU-bound on the staging VM: one render at a time; identical requests are reused.
- The deploy image's FFmpeg (Debian 5.1) differs from development (6.1): `pnpm media:selftest`
  renders and checks a synthetic video and must pass after each deploy (DEPLOYMENT.md).
- Caption timing is per sentence (scene windows), not per word; word timing needs speech
  recognition (a later `TranscriptionProvider`).

## Alternatives considered

- **A cloud render API** (paid, per minute): unnecessary cost and a new data processor for work
  FFmpeg does well locally.
- **Concatenate provider clips without re-encoding**: inputs differ in size, rate and codec;
  captions and loudness need a re-encode anyway.
- **Approve renders implicitly when QC passes**: QC cannot judge identity, facts or brand; the
  human gate is a non-negotiable principle (CLAUDE.md §2.11).
