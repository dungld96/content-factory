# Known limitations (MVP, after M8.5)

What the AI Content Factory does not do, or does only partly, as of 2026-11-20. Items marked
**(pilot)** were found in the M8 pilot (`docs/design/m8/pilot-report.md`); M8.5 fixed most of the
workflow gaps it found (`docs/design/M8.5-design-review-package.md`).

## Product scope

- **One output format**: short vertical video (9:16, 1080×1920, H.264/AAC, up to 3 minutes).
  Other formats from the format registry (R0) have no production pipeline yet.
- **No publishing**: the export is a downloadable package (MP4, SRT, thumbnail, manifest, cost
  report). Nothing is posted to TikTok, YouTube or other platforms (out of MVP scope).
- **One language per content item**; translation or multi-language variants are separate items.
- **Captions come from the voice-over text** (no speech recognition): cue timing is proportional
  to text length within each scene, not aligned to the spoken words. Line breaks follow punctuation
  and balanced lengths; without a dictionary they can still split a multi-word term.
- **Music** must be uploaded by the user with a licence note; there is no music library.
- **No automatic visual quality scoring**: automated QC checks the technical output (format, size,
  frame rate, duration, loudness, black/frozen/silent stretches); whether the content is good,
  correct and on-brand is the human reviewer's decision at each gate. Video models can invent small
  details **(pilot)**.
- **Single tenant, one deployment**: projects and roles (owner, editor, viewer), but no
  organisations, billing, invoicing or per-user quotas.

## Workflow gaps

- Scene edits are validated one at a time against the total-duration rule: when retiming several
  scenes, change them in an order that keeps the total in range (the error names the rule and the
  measured total) **(pilot)**.
- Generated storyboards use the routed clip model's lengths; scenes edited by hand may use any
  length (the clip plan marks scenes longer than the model allows).

## Providers and models

- **One gateway in production use (OpenRouter)**; each task has one routed model. There is no
  automatic fallback to another model or provider: when a provider's circuit is open, work waits
  (up to 2 h) and then fails.
- **Model capabilities are recorded, not discovered**: a routable model can still reject a request
  or ignore an instruction. Gemini 3.5 Flash Lite accepts the storyboard schema in `basic` schema
  mode but did not keep to the clip lengths, so storyboards stay on Claude Haiku 5.5 (M8.5).
- **Video providers keep prompts and keyframes** (no zero-data-retention option for video).
- **A lost video submission may be charged** (`SUBMIT_OUTCOME_UNKNOWN`): it is never resubmitted
  automatically; its reserved amount stays counted until an owner resolves it.
- **An unconfirmed script, storyboard or voice-over call may be charged** (`CALL_OUTCOME_UNKNOWN`,
  a timeout or lost connection after sending): the job ends without retrying, its reservation is
  held, and Resume asks before trying again (P3). Image calls are retried: OpenRouter documents
  that a disconnected image request is not billed.
- A worker that stops in the middle of a text or speech call is still retried (`WORKER_LOST`);
  the interrupted call is recorded `outcome_unknown` later and may have been charged.

## Cost

- **Prices change.** Estimates use the registry's recorded prices (imported from OpenRouter's
  catalog, refreshed by an operator); the ledger records what the provider reports.
- **TTS cost is recorded as an estimate** (OpenRouter returns no per-call cost for these TTS
  calls); estimates equal the published per-character price **(pilot)**.
- Unknown cost is never shown as $0: such calls are counted; budgets reserve USD 0.50 per call for
  them.
- Free tiers are not used or relied on.

## Operations and security

- **One server** (Docker Compose on an Ubuntu VPS): no high availability; a server failure means
  restoring a backup.
- **Backups are whole-system snapshots** (database + objects), nightly at most; no point-in-time
  recovery. The schedule and the off-server copy (rclone: S3-compatible storage or SFTP) are
  set up once by the operator (DEPLOYMENT.md); remote copies are kept 30 days by default.
- An interrupted image or render attempt can leave stored objects that no record references
  (harmless, not served; they only use disk).
- The Content-Security-Policy allows inline `style` attributes (`style-src 'unsafe-inline'`), which
  React components use; scripts need the per-request nonce.
- **Monitoring is log-based**: fixed event names for alerts (DEPLOYMENT.md), no metrics stack or
  paging.
- Accounts are created by an operator (CLI); there is no self-service sign-up or password reset by
  email.
