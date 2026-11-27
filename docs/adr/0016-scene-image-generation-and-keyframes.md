# ADR-0016: Scene image generation, keyframes and the first image provider

- Status: Accepted (M4 design package revision 1, approved 2026-11-18; implemented in M4a–M4e)
- Date: 2026-11-18
- Milestone: M4

## Context

M4 adds the first paid media step: images for the scenes of an approved storyboard, generated
by a replaceable provider, stored in object storage, reviewed by a person, with full lineage
(prompt, model, inputs, job, cost). Only OpenRouter's official documentation could be verified
from the build environment (`docs/design/m4/openrouter-image-verification.md`).

## Decision

1. **Provider.** The first image adapter is the OpenRouter Image API (`POST /api/v1/images`,
   synchronous, base64 output, all-or-nothing billing) behind a capability-specific
   `ImageProvider` interface (ADR-0004). Every request sends `data_collection: "deny"`; zero data
   retention is a per-route setting (`ai_task_routes.zero_data_retention`). Imported models are
   disabled until the owner benchmarks one (`pnpm ai:registry smoke-image`, capped) and routes it.
2. **Prices.** Image prices are registry rows: per image, per pixel (per-megapixel prices) or per
   image token, optionally per resolution tier (`ai_model_prices.variant`). A model priced by
   token has no pre-generation estimate; generating then needs explicit confirmation.
3. **Jobs.** One `image_generation` job per storyboard scene, on its own BullMQ queue
   (`generation-images`: separate concurrency, 5-minute lock above the 240 s provider timeout).
   Candidates per request: 1 by default, at most 4; requests above a model's `n` limit are split
   into several calls. The prompt (`image.v1`) is built deterministically from the scene.
4. **Results.** Each image is validated (magic bytes, declared type, dimensions, limits), stored
   write-once under a content-addressed key, and recorded as a `generated` asset linked to its job
   and scene, with its reference inputs in append-only `asset_inputs`.
5. **Review and gate 3.** Candidates are approved or rejected; each scene's **keyframe** is a
   pointer (`scene_keyframes`) to an approved image of the same content item, with an
   append-only history. Gate 3 = every scene of the approved storyboard has a keyframe. The
   database enforces the keyframe rules (`AC015`).
6. **Reuse.** A scene's content hash excludes its id and number: an unchanged scene in a newer
   storyboard version reuses the earlier keyframe (no new job, no new cost), and identical inputs
   skip regeneration unless the editor asks for it (CLAUDE.md §2.9).
7. **Bytes through the API** (ADR-0006 amendment): uploads and reads stream through the API; the
   storage server is never exposed to browsers in M4.

## Consequences

- Images can be generated and reviewed end to end with the mock provider (CI, E2E) and, once a
  key is set and a model enabled, with a real model through OpenRouter.
- Direct provider adapters (OpenAI, Google, Black Forest Labs) can be added behind the same
  interface once their documentation is verified.
- Token-priced models show "unknown" cost before generation; their real cost comes from the
  provider's report after the call.

## Alternatives considered

- Image generation through OpenRouter's chat completions (`modalities: ["image"]`): the dedicated
  Image API documents per-endpoint parameters and pricing, which routing and estimates need.
- Selecting the keyframe by setting a flag on the asset: a pointer per scene keeps one keyframe per
  scene by construction and lets the same image serve identical scenes of later versions.
- One job for all scenes of a storyboard: per-scene jobs give scene-level retry and isolate
  failures (CLAUDE.md §7).
