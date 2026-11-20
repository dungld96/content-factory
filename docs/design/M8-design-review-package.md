# M8 Design Review Package — Pilot and Hardening

- Status: **Revision 1, approved by the owner (2026-11-20)**: P1–P10 as proposed (default pilot
  brief, USD 3 cap). Implemented in slices M8a–M8d (§10).
- Date: 2026-11-20
- Baseline: M7 approved (`f8ce93e`); ADR-0014 (single-VM staging), ADR-0017 (async provider
  jobs), ADR-0018 (rendering), ADR-0019 (budgets, circuits)
- Inputs: IMPLEMENTATION_PLAN §M8, DEPLOYMENT.md, COST_STRATEGY §7, `docs/design/m5/benchmark-results.md`

M8 adds almost no product features. It proves the MVP on real work (a paid pilot) and makes it safe to
run (backups that are actually restored, failure drills, deployment and limitation docs).

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                                                                                                                                            | Section |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1  | **Pilot run by Claude in this cloud environment**: the full stack (API, worker, web, PostgreSQL, Redis, SeaweedFS) runs locally here; the pilot is driven **through the web UI** (Playwright, screenshots at each gate) with **real paid providers** via the session's OpenRouter key. You review the result                                                      | §3      |
| P2  | **Pilot content**: one **30 s, 9:16, Vietnamese** video, 5 scenes, with a brief you give (default if you do not: _"3 mẹo pha cà phê phin ngon tại nhà"_, a coffee how-to for TikTok). One voice profile (MAI-Voice 2.1, `vi-VN` native voice)                                                                                                                     | §3.1    |
| P3  | **Text model for scripts and storyboards** (today routed to the mock): a capped mini-benchmark (≤ USD 0.15) generates the pilot script with up to three registered models that support the required structured output (Claude Haiku 5.5, Gemini 3.5 Flash Lite, DeepSeek V4 Flash); I route the best and say why                                                  | §3.2    |
| P4  | **Pilot budget: USD 3.00 hard** for the pilot project (monthly and per item; per request USD 2 hard). Expected spend ≈ **USD 1.30** (§3.3). Nothing beyond the cap is possible: the M7 budget blocks it                                                                                                                                                           | §3.3    |
| P5  | **Gates during the pilot**: I act as editor and owner and approve each gate (script, storyboard, keyframes, clips/voice-overs, render) **only when the result meets the brief**, recording every rejection, regeneration and manual intervention. **The final MP4 is sent to you; your review is the real gate 5**                                                | §3.4    |
| P6  | **Benchmark report** (`docs/design/m8/pilot-report.md`): per stage wall time, attempts, estimate vs reported cost, model, failures and manual interventions; cost per approved output from the ledger; findings and follow-ups                                                                                                                                    | §4      |
| P7  | **Backup and restore that is proven**: `acf.sh backup` writes a PostgreSQL dump (custom format) plus an export of every stored object with a SHA-256 manifest; `acf.sh restore` rebuilds an empty stack from it and verifies counts and checksums. An automated **restore drill** test runs the round trip. Off-VM copies: documented, your choice of destination | §5      |
| P8  | **Hardening by drills, not features**: automated drills for worker crash mid-job (text, image, video submit, render), Redis loss, provider outage (circuit), and a restore; a dependency audit (`pnpm audit`, fix high/critical); a production config review (headers, cookies, rate limits, env check). Fix only what the drills find                            | §6      |
| P9  | **User acceptance testing**: a written UAT script (`docs/UAT.md`, ~12 scenarios in plain language) that you (or a colleague) run on the staging VM or locally; I run the same script myself first and fix blockers; your results are recorded in the pilot report                                                                                                 | §7      |
| P10 | **Docs**: DEPLOYMENT.md completed (upgrade path through M7, backup/restore, rollback, post-deploy checks), `docs/KNOWN_LIMITATIONS.md` (what the MVP does not do, cost and quality caveats), README status; ADR-0020 for backup/restore                                                                                                                           | §8      |

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M8):** pilot content project; benchmark report; user acceptance
testing; backup/restore procedure; deployment documentation; known limitations list. Hardening:
failure drills and fixes they require.

**Out of scope:** new product features; another provider or model integration (only enabling or
routing models already registered); direct social publishing, multi-tenant billing, analytics
(CLAUDE.md §11); automatic off-site backup scheduling to a cloud bucket (documented as a command,
your destination); load testing beyond a sanity check (one VM, editorial workload); deploying the
VM myself (this session has no access to it: the docs and a checklist cover it).

**Acceptance (IMPLEMENTATION_PLAN §M8) and evidence:**

| Criterion                                         | Evidence                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One complete content item reaches approved export | The pilot item exported: MP4 + SRT + thumbnail + manifest + cost report, sent to you; ledger, jobs and gate approvals in the database; screenshots per gate   |
| Cost per output is measured                       | Pilot report: cost per stage and total from the ledger (reported vs estimated vs unknown kept apart), compared with the estimates shown before each paid step |
| Failures and manual interventions are documented  | Pilot report lists every failed job, retry, rejection, regeneration and manual action with the reason; drill results in §6                                    |

## 2. What exists

- Every stage from brief to export works end to end with mocks (E2E) and has been called for real
  once per model in the M5 benchmark (USD 1.03).
- Budgets, reservations, circuits, resume, cost dashboard and operations page (M7).
- Deployment: Docker Compose on one VM (`infra/deploy`, `acf.sh`, ADR-0014); backups today are
  only a manual `pg_dump` and VM disk snapshots (DEPLOYMENT §6). **Object storage has no export, and
  no restore has ever been tested.**
- Routes: images Seedream 5.0 Flash, clips Veo 3.1 Lite; **scripts and storyboards still route to
  the mock**; TTS models enabled (ElevenLabs v2/v3, MAI-Voice 2.1), chosen per voice profile.

## 3. Pilot (P1–P5)

### 3.1 Run

One project "Pilot" with its own budget (P4), one content item from your brief (P2), driven
through the web UI by Playwright against the local stack with real providers. Each gate gets a
screenshot; every job, event and ledger row stays in PostgreSQL and goes into the report. Outputs
(MP4, SRT, thumbnail, manifest, cost report) are sent to you; they are not committed (`benchmark/`
is git-ignored).

### 3.2 Text model (P3)

Only models already in the registry, enabled for the pilot after checking they support the
structured-output parameters the script and storyboard jobs require (routing refuses others). The
mini-benchmark generates the same script with each candidate (capped, one call each plus at most
one repair); I compare schema validity, Vietnamese quality, adherence to the brief and cost, route
the winner for both text tasks and record the comparison in the report.

### 3.3 Expected cost (benchmark prices, 2026-11-19)

| Stage                    | Basis                                  | Estimate       |
| ------------------------ | -------------------------------------- | -------------- |
| Script + storyboard      | ~20 k tokens, small model              | ≤ USD 0.05     |
| Text mini-benchmark (P3) | 3 models × 1 script                    | ≤ USD 0.15     |
| Keyframes                | 5 scenes × 1–2 candidates × USD 0.018  | USD 0.09–0.18  |
| Clips                    | 30 s × USD 0.03/s (Veo 3.1 Lite, 720p) | USD 0.90       |
| Voice-overs              | 5 × ~USD 0.003 (MAI-Voice)             | ≤ USD 0.02     |
| Render, export           | local FFmpeg                           | USD 0          |
| **Total**                | one regenerated clip adds ≈ USD 0.18   | **≈ USD 1.30** |

Your OpenRouter key had a USD 5 limit with USD 1.03 spent in M5. If its remaining credit is below
USD 3, the pilot stops at a budget or provider refusal (no partial overspend); please top up or
tell me a lower cap.

### 3.4 Gates and interventions (P5)

I approve a gate only when its result meets the brief; otherwise I reject or regenerate (each
costed and recorded). "Manual intervention" means anything outside the normal UI flow (a CLI
command, a database fix, a restart): each one is a finding, and each finding is either fixed in M8
or listed as a known limitation.

## 4. Benchmark report (P6)

`docs/design/m8/pilot-report.md`: environment and model versions; per stage (attempts, wall time,
model, estimate, reported cost, cost status); total and cost per approved video; budget events;
failures, retries and interventions; quality notes per gate (with screenshots kept locally);
comparison with M5 benchmark prices; recommendations (routing, defaults, limits).

## 5. Backup and restore (P7)

- **Backup** (`acf.sh backup [dir]`, default `backups/<UTC timestamp>/`):
  1. `pg_dump --format=custom` of the application database (schema, data, triggers);
  2. object export by a new API CLI (`node dist/cli/storage-cli.js export <dir>`): every object of
     the bucket streamed to files plus `manifest.json` (key, size, SHA-256, content type); the API
     and worker keep running (objects are immutable, keys content-addressed: a later object only
     adds files);
  3. `backup.json`: app version (git commit), migration list, counts, timestamps.
- **Restore** (`acf.sh restore <dir>`) onto an **empty** stack (refuses a non-empty database or
  bucket unless `--force-empty-check` is explicitly overridden): `pg_restore`, object import with
  checksum verification, migration check, then `verify`: database row counts and every
  `assets.storage_key` present with the recorded checksum.
- **Proof**: an integration test performs backup → empty database and bucket → restore → verify;
  the same drill is run once by hand in this environment and documented. On the VM: a nightly
  `cron` line is documented (you decide whether to enable it); retention keeps the last 7 local
  backups; copying off the VM (e.g. `gcloud storage cp -r`) is documented with your bucket name as
  a placeholder.
- Secrets are not part of a backup (`.env.production` is backed up by you, separately, privately).

## 6. Hardening (P8)

| Drill                                 | How                                                                                        | Pass when                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Worker killed during a text/image job | Integration: stop the worker mid-attempt, start a new one                                  | The job finishes once (redelivered or reconciled), no duplicate version  |
| Worker killed after a video submit    | Integration with the mock video provider                                                   | Never resubmitted; polling resumes; one clip                             |
| Worker killed during a render         | Integration                                                                                | Render job retried or failed cleanly; no half-written outputs referenced |
| Redis flushed                         | Integration: `FLUSHALL` with jobs queued                                                   | The reconciler re-enqueues from PostgreSQL; all jobs complete            |
| Provider outage                       | Mock provider failing with 503 ×5                                                          | Circuit opens, jobs wait, recover after the trial; no failed jobs        |
| Restore                               | §5                                                                                         | Verified counts and checksums                                            |
| Dependency audit                      | `pnpm audit --prod`                                                                        | No high/critical advisories (fixed by pinned upgrades or documented)     |
| Production config                     | Review of security headers, cookie flags, CORS, rate limits, `env:check` on the deploy env | Findings fixed or documented                                             |

Existing tests already cover parts of these (M3 reconciler, M5 video resume, M7 circuits); the
drills add the missing combinations and run them as one suite (`pnpm test:drills`, part of
integration).

## 7. User acceptance testing (P9)

`docs/UAT.md`: about 12 scenarios written for a non-developer (sign in; create project and
content; brief; script review and edit; storyboard; keyframes; clips with estimate and budget
confirmation; voice-overs; render, review, export and download; costs page; operations page and
resume; roles: viewer cannot change, editor cannot change budgets). Each has steps, expected
result and a pass/fail box. I run it myself first against the local stack (mock providers except
the pilot) and fix blockers; you run it when convenient and send results, which I record.

## 8. Documentation (P10)

- DEPLOYMENT.md: first install and the upgrade path from any earlier milestone (migrations, new
  env vars since M4), backup/restore, rollback (redeploy previous commit + restore), post-deploy
  checklist (`media:selftest`, health, a mock render).
- `docs/KNOWN_LIMITATIONS.md`: product limits (one VM, one language per item, no publishing, no
  automatic provider fallback, captions only from voice-over text, held reservations need a
  human), cost caveats (provider prices change; estimates vs reported), quality caveats (model
  output varies; no automated visual quality scoring), security notes.
- ADR-0020: backup format and restore guarantees.

## 9. Risks

| Risk                                                             | Mitigation                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Pilot spend above estimate (retries, regenerations)              | Hard USD 3 budget (M7); every regeneration is a recorded decision                        |
| OpenRouter credit runs out mid-pilot                             | Provider refusal is non-retryable; resume after top-up (M7 resume)                       |
| Model output poor in Vietnamese                                  | P3 mini-benchmark; quality notes in the report; your review is the final gate            |
| Pilot passes in this environment but the VM differs (FFmpeg 5.1) | `media:selftest` in the image after deploy; UAT on the VM                                |
| Restore misses data (objects written during the dump)            | Content-addressed immutable objects: objects without a database row are harmless; verify |
| My judgement at the gates differs from yours                     | You receive every gate's screenshot and the final MP4; nothing is published              |

## 10. Implementation plan (each slice tested before the next)

| Slice | Content                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| M8a   | Backup/restore: storage CLI (export/import/verify), `acf.sh backup                                                       | restore`, restore drill test, ADR-0020 |
| M8b   | Hardening drills suite, dependency audit, production config review; fixes                                                |
| M8c   | Pilot: text mini-benchmark, routing, pilot run through the UI with real providers, pilot report (needs your go on P2–P5) |
| M8d   | UAT script (run by me first), DEPLOYMENT.md completion, KNOWN_LIMITATIONS.md, status                                     |
