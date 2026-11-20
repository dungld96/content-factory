# Product Requirements (PRD)

**Product:** AI Content Factory · **Release:** MVP (delivered 2026-11-20) · **Channel:** vertical
short video (TikTok, Reels, Shorts)

## 1. Problem

Making short social videos takes many separate tools and manual steps: research, scripting,
storyboarding, image, video and voice generation, editing, checks and asset organization. Switching
tools makes production slow, expensive and hard to reproduce.

AI Content Factory gives one workspace and one workflow across several AI providers, tracks cost,
and keeps reusable brand and character assets.

## 2. Goals

1. Turn a brief into a production-ready script and storyboard.
2. Generate images, clips and audio with replaceable providers.
3. Assemble approved clips into a final MP4.
4. Track usage and cost per job, scene and content item.
5. Keep lineage: prompts, versions, character and environment references.
6. Recover from provider failures without redoing successful work.
7. Require human approval at defined gates.

## 3. Non-goals (MVP)

Multi-tenant SaaS or billing · publishing to social platforms · training or fine-tuning models ·
promised viral performance · unlimited free generation · livestream avatars · automatic approval
of sensitive or commercial claims.

## 4. Roles

| Role | Can |
|---|---|
| Owner | Everything an editor can, plus project settings, members, budgets, resolving held charges |
| Editor | Create briefs, generate, edit, review and approve, render and export |
| Viewer | Read everything; cannot generate, edit or approve |

Accounts are created by an operator (CLI). Provider secrets never reach the browser.

## 5. User journeys

**A. Create content.** Choose a project (and optionally a channel), enter the brief (topic,
audience, objective, tone, duration, format, language, references). Generate and review the
script, then the storyboard; approve each.

**B. Generate media.** For the approved storyboard: estimate, then generate keyframes; choose one
per scene. Estimate and generate clips and voice-overs; choose one per scene. Failed scenes are
retried on their own.

**C. Render and export.** Render the video with captions and optional music; automated checks
run. Preview, approve and export the package.

**D. Review costs.** The Costs page shows the month's spend against the budget, by item, stage and
model, with reported, estimated and unknown costs apart. Budgets block or ask before paid work.

## 6. Functional requirements

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-001 | Create and manage projects | P0 | Done |
| FR-002 | Create briefs and content items | P0 | Done (masters and variants) |
| FR-003 | Research summary and ideas | P1 | Not built (script cites the brief's sources only) |
| FR-004 | Generate and edit scripts | P0 | Done |
| FR-005 | Generate storyboards with scenes | P0 | Done |
| FR-006 | Characters, environments, reference assets | P0 | Done |
| FR-007 | Generate images through adapters | P0 | Done |
| FR-008 | Generate video clips through adapters | P0 | Done |
| FR-009 | Voice-over and subtitles | P1 | Done |
| FR-010 | Assemble media with FFmpeg | P0 | Done |
| FR-011 | Preview, approve, download the final export | P0 | Done |
| FR-012 | Track usage and cost | P0 | Done |
| FR-013 | Retry a single failed scene | P0 | Done |
| FR-014 | Resume production from the last successful stage | P0 | Done |
| FR-015 | Prompt and asset lineage | P0 | Done |
| FR-016 | Project and content budget limits | P1 | Done |
| FR-017 | Publish or schedule to social platforms | P2 | Not in MVP |
| FR-018 | Social analytics | P2 | Not in MVP |

## 7. Non-functional requirements

- **Reliability:** jobs survive API and worker restarts; finished stages are not redone unless asked.
- **Traceability:** every output links to provider, model, prompt snapshot, inputs and job.
- **Security:** credentials server-side only; secrets never logged.
- **Cost safety:** every paid job has an estimate or an explicit "unknown cost" confirmation, and a budget check.
- **Extensibility:** a new provider needs no change to content-domain logic.
- **Observability:** structured logs, job state, retry history and provider errors are queryable.
- **Portability:** storage behind an S3-compatible interface.
- **Usability:** script, storyboard, media and final render are reviewed separately.

## 8. MVP acceptance criteria

All met in the M8 pilot (`docs/design/m8/pilot-report.md`, `docs/UAT.md`):

1. A user can create a project and a content item.
2. A valid brief produces a structured script and storyboard.
3. A configured image provider creates images.
4. A configured video provider creates clips, or reports a clear limitation.
5. Audio can be generated or imported.
6. FFmpeg produces a valid vertical MP4 from approved assets.
7. The output can be previewed and downloaded.
8. Usage and cost are recorded; otherwise marked estimated or unknown.
9. A failed scene can be retried without rerunning completed scenes.
10. Prompt, model, provider, inputs, outputs and timestamps are recorded.
11. A project budget can block new paid jobs.
12. Human approval is required before the final export is approved.

## 9. Pilot metrics

Tracked, not promised: cost per approved video · production time per video · first-attempt job
success · retries per scene · share of outputs passing review · manual editing time · character
consistency · estimated vs actual cost.
