# Product Requirements Document (PRD)

**Product:** AI Content Factory  
**Version:** 1.0.0  
**Target release:** MVP  
**Primary channel:** Vertical short-form video (TikTok/Reels/Shorts)

## 1. Problem statement

Producing short-form social content requires many disconnected tools and repetitive manual steps: research, scripting, storyboard preparation, image generation, video generation, voice generation, editing, quality checks, and asset organization. Tool switching makes production slow, expensive, and difficult to reproduce.

AI Content Factory provides one workflow and one project workspace to coordinate these tasks across multiple AI providers while tracking cost and preserving reusable brand/character assets.

## 2. Goals

1. Convert a natural-language brief into a production-ready script and storyboard.
2. Generate images, video clips, and audio using replaceable providers.
3. Assemble approved clips into a final MP4.
4. Track actual provider usage and estimated/actual cost per job, scene, and content item.
5. Preserve asset lineage, prompt versions, character references, and environment references.
6. Recover from provider failures without restarting successful stages.
7. Require human approval at defined quality gates.

## 3. Non-goals for MVP

- Multi-tenant public SaaS, billing, subscriptions, or marketplace.
- Fully autonomous publishing to every social platform.
- Training or fine-tuning proprietary foundation models.
- Guaranteed viral performance or automatic growth.
- Unlimited free generation.
- Real-time livestream avatars.
- Fully autonomous approval of sensitive or commercial claims.

## 4. Users and roles

### MVP roles

- **Owner/Admin:** manages projects, providers, credentials, budgets, and users.
- **Editor:** creates briefs, edits scripts/storyboards, reviews assets, approves exports.
- **Viewer:** can view projects and outputs but cannot trigger paid generation.

For a single-user MVP, authentication can initially be simple but must not expose provider secrets to the browser.

## 5. Core user journeys

### Journey A — Create a content item

1. User selects a project and channel.
2. User enters topic, audience, objective, tone, target duration, format, language, and optional references.
3. System validates the brief and creates a content item.
4. Research and planning stages produce structured outputs.
5. User reviews and edits the content angle and script.
6. System creates storyboard scenes.
7. User approves the storyboard.

### Journey B — Generate media

1. User selects approved storyboard scenes.
2. System selects a provider/model based on capability, policy, budget, and availability.
3. System creates generation jobs.
4. Worker submits provider requests and polls asynchronous jobs where needed.
5. Outputs are downloaded, validated, stored, and linked to their source jobs.
6. User reviews images and clips.
7. Failed scenes can be retried independently.

### Journey C — Render and export

1. User selects approved clips and audio.
2. System validates media compatibility.
3. FFmpeg worker assembles scenes, audio, subtitles, and transitions.
4. System validates final duration, resolution, codec, audio, and file integrity.
5. User previews and approves the final export.
6. System creates a downloadable publishing package.

### Journey D — Review costs

1. User opens content cost summary.
2. System shows LLM input/output tokens, image jobs, video duration/credits, TTS usage, retries, and estimated/actual cost.
3. User can inspect provider/model and generation job details.
4. Budget limits prevent new paid jobs when configured thresholds are exceeded.

## 6. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-001 | Create and manage content projects | P0 |
| FR-002 | Create content brief and content item | P0 |
| FR-003 | Generate research summary and ideas | P1 |
| FR-004 | Generate and edit scripts | P0 |
| FR-005 | Generate storyboard with scenes | P0 |
| FR-006 | Manage characters, environments, and reference assets | P0 |
| FR-007 | Generate images through provider adapters | P0 |
| FR-008 | Generate video clips through provider adapters | P0 |
| FR-009 | Generate voice-over and subtitles | P1 |
| FR-010 | Assemble media using FFmpeg | P0 |
| FR-011 | Preview, approve, and download final export | P0 |
| FR-012 | Track provider usage and costs | P0 |
| FR-013 | Retry an individual failed scene | P0 |
| FR-014 | Resume production from last successful stage | P0 |
| FR-015 | Maintain prompt and asset lineage | P0 |
| FR-016 | Configure project and content budget limits | P1 |
| FR-017 | Publish/schedule directly to social platforms | P2 |
| FR-018 | Collect social analytics | P2 |

## 7. Non-functional requirements

- **Reliability:** queued jobs survive API/worker restarts; completed stage outputs are not regenerated without explicit request.
- **Traceability:** every generated output links to its provider, model, prompt version, input assets, and job.
- **Security:** provider credentials are server-side only; secrets are never logged.
- **Cost safety:** every paid job has a preflight estimate or explicit “unknown cost” warning and a budget check.
- **Extensibility:** adding a provider should not require changing content-domain logic.
- **Observability:** structured logs, job state, retry history, latency, and provider errors are queryable.
- **Portability:** media storage uses an S3-compatible abstraction.
- **Usability:** users can inspect and approve script, storyboard, assets, and final export separately.

## 8. MVP acceptance criteria

The MVP is accepted when:

1. A user can create a project and content item.
2. A valid brief can generate a structured script and storyboard.
3. At least one configured image provider can create an image.
4. At least one configured video provider can create a clip or the system clearly reports provider capability/configuration limitations.
5. Audio can be generated or imported.
6. FFmpeg can produce a valid vertical MP4 from approved assets.
7. The final output can be previewed and downloaded.
8. Provider usage and cost are recorded where provider data permits; otherwise the record is explicitly marked estimated/unknown.
9. A failed scene can be retried without rerunning completed scenes.
10. The system records prompt, model, provider, input assets, output assets, and timestamps.
11. A project budget limit can block new paid generation jobs.
12. Human approval is required before final export is marked approved.

## 9. Success metrics

Track these during pilot; do not treat targets as guarantees:

- Cost per approved video.
- Average production time per video.
- Percentage of generation jobs that succeed on first attempt.
- Retry rate per scene.
- Percentage of outputs passing human review.
- Time spent on manual editing per video.
- Character consistency review score.
- Cost variance: estimated vs actual.
