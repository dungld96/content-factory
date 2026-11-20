# Known limitations (MVP, after M8)

What the AI Content Factory does not do, or does only partly, as of 2026-11-20. Items marked
**(pilot)** were found in the M8 pilot (`docs/design/m8/pilot-report.md`); follow-ups are listed
there.

## Product scope

- **One output format**: short vertical video (9:16, 1080×1920, H.264/AAC, up to 3 minutes).
  Other formats from the format registry (R0) have no production pipeline yet.
- **No publishing**: the export is a downloadable package (MP4, SRT, thumbnail, manifest, cost
  report). Nothing is posted to TikTok, YouTube or other platforms (out of MVP scope).
- **One language per content item**; translation or multi-language variants are separate items.
- **Captions come from the voice-over text** (no speech recognition); cue splitting is simple and
  can produce very short cues or line breaks inside a phrase **(pilot)**.
- **Music** must be uploaded by the user with a licence note; there is no music library.
- **No automatic visual quality scoring**: automated QC checks the technical output (format, size,
  frame rate, duration, loudness, black/frozen/silent stretches); whether the content is good,
  correct and on-brand is the human reviewer's decision at each gate. Video models can invent small
  details **(pilot)**.
- **Single tenant, one deployment**: projects and roles (owner, editor, viewer), but no
  organisations, billing, invoicing or per-user quotas.

## Workflow gaps (pilot)

- Only the **latest** script version can be approved from the UI.
- The storyboard model is not told the clip model's lengths (e.g. Veo 3.1 Lite: 4, 6, 8 s): scenes
  may need retiming (the scene editor has a duration field).
- Scene edits are validated one at a time (total-duration rule) and the error does not name the
  rule.
- A voice-over longer than its scene is only reported by the render preflight.
- The voice-profile form expects the provider's exact voice id; it offers no list, and the model
  list starts with a disabled model.

## Providers and models

- **One gateway in production use (OpenRouter)**; each task has one routed model. There is no
  automatic fallback to another model or provider: when a provider's circuit is open, work waits
  (up to 2 h) and then fails.
- **Model capabilities are recorded, not discovered**: a routable model can still reject a request
  (Gemini 3.5 Flash Lite rejects the storyboard JSON schema) **(pilot)**.
- **Video providers keep prompts and keyframes** (no zero-data-retention option for video).
- **A lost video submission may be charged** (`SUBMIT_OUTCOME_UNKNOWN`): it is never resubmitted
  automatically; its reserved amount stays counted until an owner resolves it.

## Cost

- **Prices change.** Estimates use the registry's recorded prices (imported from OpenRouter's
  catalog, refreshed by an operator); the ledger records what the provider reports.
- **TTS cost is recorded as an estimate** (OpenRouter returns no per-call cost for these TTS
  calls); estimates equal the published per-character price **(pilot)**.
- Unknown cost is never shown as $0: such calls are counted; budgets reserve USD 0.50 per call for
  them.
- Free tiers are not used or relied on.

## Operations and security

- **One VM** (Docker Compose): no high availability; a VM failure means restoring a backup.
- **Backups are whole-system snapshots** (database + objects); no point-in-time recovery. Copying
  them off the VM and scheduling them is the operator's step (DEPLOYMENT.md).
- An interrupted image or render attempt can leave stored objects that no record references
  (harmless, not served; they only use disk).
- **No Content-Security-Policy on pages yet** (Next.js inline scripts need nonces); other security
  headers are set by Caddy.
- **Monitoring is log-based**: fixed event names for alerts (DEPLOYMENT.md), no metrics stack or
  paging.
- Accounts are created by an operator (CLI); there is no self-service sign-up or password reset by
  email.
