# M8c pilot report (2026-11-20)

One real content item from brief to approved export, through the web UI with real paid providers
(M8 design §3, decisions P1–P6). Environment: this cloud development container running the full
stack locally (API, worker, web production builds; PostgreSQL 17, Redis 7, SeaweedFS 4.54, FFmpeg
on Ubuntu), OpenRouter through the session's key. Each gate was driven by Playwright and
screenshotted; outputs were reviewed (frame sheets, FFprobe, loudness) before each approval. The
operator account was `pilot@acf.local` (owner of project "Pilot").

## Result

| Acceptance (IMPLEMENTATION_PLAN §M8)              | Result                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One complete content item reaches approved export | **Met.** "3 mẹo pha cà phê phin ngon tại nhà": 30.0 s, 1080×1920, H.264 High + AAC 48 kHz stereo, 30 fps, −14 LUFS, captions burned in; QC passed with no warnings; render approved; package exported (MP4, SRT, thumbnail, manifest, cost report)                                                                              |
| Cost per output is measured                       | **Met.** USD **1.0604** for the approved video (ledger), of which USD 1.0515 provider-reported and USD 0.0090 estimated; 1 call of unknown cost (a failed call, not charged). OpenRouter's own usage rose by USD 1.0607 over the pilot: the USD 0.0003 difference is four direct diagnostic calls made outside the app (§4, F3) |
| Failures and manual interventions are documented  | **Met.** 1 failed job, 0 retries, 0 budget blocks, 2 resolved by product features (Resume, scene edit); interventions below                                                                                                                                                                                                     |

Budget: project USD 3 hard monthly and per item, USD 2 hard per request (P4). Used USD 1.06; no
reservation held; no budget refusal. Estimate before the pilot: ≈ USD 1.30.

## Cost and time per stage

| Stage                    | Model                                                      | Jobs | Wall time (per job)    | Estimate shown      | Ledger cost     | Status    |
| ------------------------ | ---------------------------------------------------------- | ---- | ---------------------- | ------------------- | --------------- | --------- |
| Script (mini-benchmark)  | Claude Haiku 5.5, Gemini 3.5 Flash Lite, DeepSeek V4 Flash | 3    | 7.5 s, 3.3 s, 13.4 s   | —                   | USD 0.0035      | reported  |
| Script (used)            | Gemini 3.5 Flash Lite                                      | 1    | 3.7 s                  | —                   | USD 0.0021      | reported  |
| Storyboard (failed)      | Gemini 3.5 Flash Lite                                      | 1    | 4.4 s                  | —                   | 0 (not charged) | unknown   |
| Storyboard               | Claude Haiku 5.5                                           | 1    | 15.3 s                 | —                   | USD 0.0018      | reported  |
| Keyframes (4 × 2)        | Seedream 5.0 Flash, 1152×2048                              | 4    | 30–70 s (parallel)     | USD 0.144           | USD 0.144       | reported  |
| Clips (6 + 8 + 8 + 8 s)  | Veo 3.1 Lite, 720p, no audio                               | 4    | 111 s (parallel)       | USD 0.90            | USD 0.90        | reported  |
| Voice-overs (4 + 1 redo) | MAI-Voice 2.1, vi-VN Harper                                | 5    | 7–14 s                 | USD 0.0071 + 0.0019 | USD 0.0090      | estimated |
| Render, QC               | local FFmpeg                                               | 1    | 51 s                   | USD 0               | USD 0           | —         |
| **Total**                |                                                            | 20   | ≈ 4.5 min machine time | ≈ USD 1.05          | **USD 1.0604**  |           |

Retry cost: USD 0 (the only non-producing call failed before the provider charged). Reuse: when the
storyboard was re-versioned (§3, I5), all 4 keyframes and 4 clips were reused at USD 0 and only one
voice-over was generated again.

## Gates and decisions

1. **Script.** Mini-benchmark (P3): all three candidates produced schema-valid scripts first time.
   Gemini 3.5 Flash Lite wrote the most natural Vietnamese and explained each tip; Claude Haiku 5.5
   was concise but its narration (~50 words, ~17 s) was too short for 30 s; DeepSeek's spoken CTA
   contradicted its CTA field. Routed: scripts → Gemini. The approved version (v5) is Gemini's v4
   tightened in the editor from ~110 to 75 words (a normal edit, not an intervention).
2. **Storyboard.** Gemini failed (F1); routed storyboards to Claude Haiku 5.5 and resumed the
   failed run from the Operations page (new run linked to the failed one). Four scenes (5/7/8/10 s)
   with good prompts; retimed to 6/8/8/8 s to match the clip model's lengths (F2), then approved.
3. **Keyframes.** 2 candidates per scene; picked by fit to the narration (scene 3: water poured
   into the open phin; the other candidate poured onto a closed lid).
4. **Clips.** All four accepted as generated: faithful to the keyframes, smooth motion; a small
   invented smiley appears in a side cup's crema in scene 1 (cosmetic).
5. **Voice-overs.** Scene 4 narration (tip 3 + call to action) was 9.8 s for an 8 s scene; the render
   preflight blocked it. Shortened the scene's text (storyboard v5), re-approved; keyframes and clips
   carried over at no cost, one voice-over regenerated (6.8 s).
6. **Render (gate 5).** QC passed; reviewed frames across the timeline, captions, streams and
   loudness; approved and exported. **The owner's review of the MP4 is the real gate 5 (P5).**

## Failures, findings and interventions

| #   | Finding                                                                                                                                                                                     | Kind                  | Action                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Gemini 3.5 Flash Lite rejects the storyboard JSON schema ("produces a constraint that has too many states"); the routing filter called it eligible. Claude Haiku 5.5 and DeepSeek accept it | Failure (1 job)       | Routed storyboards to Claude Haiku 5.5; resumed via Operations. **Follow-up:** a provider-portable response schema (value constraints enforced only locally) or a registry flag |
| F2  | The storyboard model does not know the clip model's lengths (Veo 3.1 Lite: 4, 6, 8 s): a 10 s scene would have been skipped                                                                 | Product gap           | **Fixed:** scene duration is editable in the scene editor (the API already accepted it). **Follow-up:** pass the routed video model's durations into the storyboard prompt      |
| F3  | The job showed only "Provider returned error": OpenRouter hides the upstream message in `metadata.raw`                                                                                      | Diagnostics           | **Fixed:** the adapter appends the upstream provider and message (sanitized, bounded). Diagnosis needed 4 direct calls (≈ USD 0.0003)                                           |
| F4  | Only the latest script version can be approved in the UI; an earlier, better version (v2) could not be chosen                                                                               | UX gap                | Regenerated and edited instead. **Follow-up:** approve any pending version from the version list                                                                                |
| F5  | Voice field of a voice profile is free text; the registered id (`vi-VN-Harper:MAI-Voice-2.1`) is not offered; the model list defaults to a disabled model                                   | UX gap                | Entered the full id. **Follow-up:** voice picker from the model's voice list; enabled models first                                                                              |
| F6  | Scene edits are validated one at a time (total duration rule), so retiming needs a specific order; the error says only "The content breaks a rule"                                          | UX gap                | Edited in a valid order. **Follow-up:** name the rule (and the totals) in the message                                                                                           |
| F7  | Narration longer than its scene is only caught at render preflight                                                                                                                          | UX gap                | Shortened the scene text. **Follow-up:** warn on the voice-over panel (the plan already knows `exceedsScene`)                                                                   |
| F8  | TTS cost stays `estimated`: OpenRouter's generation lookup does not return a cost for these TTS calls even after the M5 retries                                                             | Cost accuracy (small) | Estimates equal the published per-character price; listed as a known limitation                                                                                                 |
| F9  | Caption segmentation: a 0.3 s cue ("nhé.") and line breaks inside phrases                                                                                                                   | Quality (minor)       | **Follow-up:** merge very short cues; break lines at phrase boundaries                                                                                                          |
| F10 | Veo invents small details (a smiley in the crema)                                                                                                                                           | Model behaviour       | Accepted; human review remains the gate                                                                                                                                         |

Manual interventions outside the UI: none for the content itself. Operator actions done by CLI, as
designed: enabling the three text models, routing scripts and storyboards (`pnpm ai:registry
route set …`). Diagnosis of F1 used direct OpenRouter calls. Environment restarts (the session's
worker was restarted twice; Docker and the app were brought back up) did not lose any state: every
job, selection and approval was in PostgreSQL, and the next step continued where it stopped.

## Comparison with the M5 benchmark

Seedream (USD 0.018/image) and Veo 3.1 Lite (USD 0.03/s at 720p, no audio) cost exactly what the
benchmark measured and what the estimates showed; Veo returned 24 fps clips (rendered at 30 fps).
Clip latency ~110 s for 6–8 s clips (benchmark: 49 s for 4 s).

## Recommendations

- Keep routes: scripts Gemini 3.5 Flash Lite, storyboards Claude Haiku 5.5, keyframes Seedream 5.0
  Flash, clips Veo 3.1 Lite (720p), narration MAI-Voice 2.1 vi-VN.
- Defaults hold: USD 3 per item soft and USD 2 per request hard leave room for one regeneration
  round of a 30 s video (≈ USD 1.05 + ≈ USD 0.25 per regenerated clip).
- Plan the follow-ups F1, F2, F4–F7 and F9 for the next product iteration (none blocks the MVP).
