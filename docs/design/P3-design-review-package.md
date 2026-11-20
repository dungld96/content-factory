# P3 Design Review Package — Worker Monitoring & Smart Recovery

- Status: **Revision 1, proposed** (awaiting owner review)
- Date: 2026-11-20
- Baseline: MVP complete (M0–M8.5). Input: `docs/post-mvp/POST_MVP_AUDIT.md` §A3, §B3, §C3;
  owner decisions of 2026-11-20 (hold-and-ask for unknown outcomes; P3 first).

P3 makes the recovery the backend already has usable from the UI, and closes one cost gap. It
does **not** rebuild the reconciler, dead-letter queue, circuit breaker, resume, execution keys or
held reservations: each is reused unchanged unless named below.

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                                                                                                              | Finding                                                                                | Section |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------- |
| W1  | **Resume confirms by error code**: the Resume button reads the error code and `error.current`, shows what it is asked to confirm (the clip estimate, unknown cost, possible double charge) in one dialog, and resends with the matching flag. No more matching on message text                                                      | Clip resume always fails (`ESTIMATE_CHANGED`); `UNKNOWN_COST_NOT_ACCEPTED` not offered | §2      |
| W2  | **Cancel from the UI**: a Cancel button next to every running job line (script, storyboard, scene batches, render). It cancels the job's production run, with the existing warning for submitted clips                                                                                                                              | API only today                                                                         | §3      |
| W3  | **One error catalogue**: a typed list of every job error code (`JOB_ERROR_CODES` in `@acf/contracts`); the worker can only end jobs with listed codes; the web maps each to a text and an action group: _Retry_, _Change the input_, _Ask an operator_, _Possibly charged_. Fixes `AUTH`/`INSUFFICIENT_CREDITS`, which never match  | 13 of ~35 codes mapped; two wrong                                                      | §4      |
| W4  | **Activity tab** in the content workspace: the item's jobs, newest first, compact (stage, scene, status, attempt, model, cost, readable error), each row expandable to its event history. New read endpoint `GET /content/:contentId/jobs`; `storyboardSceneId` added to the job DTO (additive)                                     | Events returned but never shown; no run view                                           | §5      |
| W5  | **Hold and ask for unknown outcomes of LLM and TTS calls** (owner decision): a call that timed out or lost its connection after sending ends the job with `CALL_OUTCOME_UNKNOWN`, without automatic retry. The reservation is **held** (owner settles or releases it, as for clips) and Resume needs the double-charge confirmation | Up to 3 paid attempts after a timeout today                                            | §6      |
| W6  | **Images keep retrying** after a timeout: OpenRouter documents all-or-nothing image billing and that a client disconnect is never billed (`docs/design/m4/openrouter-image-verification.md` §1)                                                                                                                                     | Exception to W5, needs confirmation                                                    | §6      |

**Out of scope:** changing the reconciler, the retry policy for other errors (rate limits, 5xx),
automatic fallback to another model, circuit control in the UI (P1, needs the operator role),
push updates (SSE/WebSocket), and jobs lost by a worker crash in the middle of a call
(`WORKER_LOST`, §9).

**No migrations.** API changes are additive: one read endpoint, one optional DTO field, one new
error code value.

## 1. Acceptance

| Criterion                                                                                 | Evidence                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A failed clip batch resumes from the UI after confirming the estimate shown               | E2E (mock video provider fails once, Resume, confirm, clip arrives); API integration: resume of a video job with and without `confirmedEstimateUsd`                                     |
| No path sends a paid call a second time after an unknown outcome without explicit consent | Worker integration: LLM and TTS timeouts end with `CALL_OUTCOME_UNKNOWN`, one provider call, reservation `held`; resume skips them unless `acceptPossibleDoubleCharge`; video unchanged |
| Images still retry safely                                                                 | Worker integration: image timeout → retried within attempts (unchanged test kept)                                                                                                       |
| Users can cancel a running batch                                                          | E2E: cancel a running storyboard job; content status returns; clip warning shown for submitted clips                                                                                    |
| Every failure says what to do                                                             | Unit: every `JOB_ERROR_CODES` entry has a text and a group (compile-time `Record`); worker typecheck refuses unlisted codes                                                             |
| Users can see what happened to a job                                                      | E2E: Activity tab lists jobs and expands one to its events (queued → running → failed → queued → …)                                                                                     |
| Nothing else changes                                                                      | Existing unit, integration and E2E suites pass unchanged; permission matrix extended for the new endpoint                                                                               |

## 2. Resume confirmations (W1)

**Today.** `apps/web/src/components/resume-run.tsx` sends `{}`, then `{ acceptPossibleDoubleCharge:
true }` if the error _message_ contains that word. `ResumeService.resume`
(`apps/api/src/generation/resume.service.ts`) forwards `confirmedEstimateUsd` and
`acceptUnknownCost` only when given, so a clip batch always fails with `409 ESTIMATE_CHANGED`
(`VideosService.assertConfirmed`, `videos.service.ts:661`). A soft budget is already handled:
`mutate()` asks and resends with `acceptOverBudget` (`apps/web/src/lib/api-client.ts`).

**Change (web only).**

1. `MutationResult` gains `current?: unknown` (the API's `error.current`, already sent).
2. `ResumeRunButton` loops at most three times, adding one consent per round:

| Response                                                                  | Shown in the dialog (existing `Modal`)                            | Resent with                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `409 ESTIMATE_CHANGED`                                                    | Scenes and total from `current` (the clip estimate)               | `confirmedEstimateUsd: current.totalEstimatedUsd` (or `null` + `acceptUnknownCost` when the total is unknown) |
| `422 UNKNOWN_COST_NOT_ACCEPTED`                                           | "Some calls have no known price; up to USD 0.50 each is reserved" | `acceptUnknownCost: true`                                                                                     |
| `409 NOTHING_TO_RESUME` with `current.skipped[].reason = outcome_unknown` | Which jobs may already be charged                                 | `acceptPossibleDoubleCharge: true`                                                                            |
| `409 BUDGET_CONFIRMATION_REQUIRED`                                        | (unchanged: `mutate()` confirm)                                   | `acceptOverBudget: true`                                                                                      |
| `402 BUDGET_EXCEEDED`, other errors                                       | The error text; no resend                                         | —                                                                                                             |

The same dialog replaces `window.confirm` here. Nothing changes in the API.

## 3. Cancel (W2)

`POST /production-runs/:runId/cancel` exists (editor) and settles jobs, content status and
reservations (`generation.service.ts`, `job-store.ts`). New `CancelRunButton`
(`apps/web/src/components/`) next to `ResumeRunButton`, shown while a job is `queued` or
`running`, in `GenerateButton` (`pipeline-controls.tsx`), the scene tabs (images, clips,
voice-overs: the batch's run) and the render panel. For a submitted clip it repeats the existing
text: "canceling stops following it; the provider may still charge" (`CANCELED_BY_USER`). The
button says what it cancels ("Cancel this batch: 4 scenes").

## 4. Error catalogue (W3)

**Today.** `jobErrorText` (`apps/web/src/lib/format.ts`) maps 13 codes, worded for clips. Job
codes are free strings: provider codes (`AUTHENTICATION`, `CONTENT_POLICY`,
`PROVIDER_BUDGET_EXCEEDED`, `RATE_LIMITED`, …), worker codes (`OUTPUT_INVALID`, `WORKER_LOST`,
`MODEL_LIMITS`, `NO_ELIGIBLE_MODEL`, `INVALID_JOB_INPUT`, `REFERENCE_MISSING`,
`RENDER_INPUT_INVALID`, `RENDER_QC_FAILED`, `BUDGET_EXCEEDED`, `STORAGE_NOT_CONFIGURED`, …) and
video codes (`SUBMIT_OUTCOME_UNKNOWN`, `PROVIDER_TIMEOUT`, `OUTPUT_EXPIRED`, …). `AUTH` and
`INSUFFICIENT_CREDITS` in the table are never produced.

**Change.**

- `packages/contracts/src/job-errors.ts`: `JOB_ERROR_CODES` (const list) and `JobErrorCode` type.
  The DTO field `errorCode` stays `string | null` (old rows and clients keep working).
- Worker: `failFinal` and `retry` in `generation-processor.ts`, `media-jobs.ts` and
  `render-jobs.ts` take `JobErrorCode`; provider codes pass through a typed mapping. A new code
  then fails the typecheck until it is listed.
- Web: `apps/web/src/lib/job-errors.ts` with `Record<JobErrorCode, { text; group }>` (exhaustive
  by type), replacing `jobErrorText`. Texts name the stage generically ("the provider failed")
  instead of "the clip". Unknown codes from old rows fall back to the raw code.

| Group            | Examples                                                                                                           | What the UI offers                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Retry            | `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TIMEOUT` (images), `WORKER_LOST`, `OUTPUT_INVALID`                        | Resume / Regenerate                                                      |
| Change the input | `CONTENT_POLICY`, `MODEL_LIMITS`, `INVALID_REQUEST`, `UNSUPPORTED_PARAMETER`, `RENDER_INPUT_INVALID`               | Edit, pick another model                                                 |
| Ask an operator  | `AUTHENTICATION`, `PROVIDER_BUDGET_EXCEEDED`, `NO_ELIGIBLE_MODEL`, `STORAGE_NOT_CONFIGURED`, `MEDIA_TOOLS_MISSING` | Text only                                                                |
| Possibly charged | `SUBMIT_OUTCOME_UNKNOWN`, `CALL_OUTCOME_UNKNOWN`, `PROVIDER_TIMEOUT`, `CANCELED_BY_USER`                           | Resume with double-charge consent; link to Operations (held reservation) |

## 5. Activity tab (W4)

**API (additive).** `GET /content/:contentId/jobs?kind=&status=&limit=&cursor=` (viewer):
the item's jobs, newest first, keyset-paginated like every list (`createdAt DESC, id DESC`),
returning `generationJobSchema` rows (no events). `generationJobSchema` gains
`storyboardSceneId: uuid | null` (additive; filled from the existing column). Events stay on
`GET /generation-jobs/:jobId`, fetched when a row is expanded. Service: `GenerationService`
reuses the existing job mapper and cost summary (`apps/api/src/generation/mappers.ts`).

**Web.** New "Activity" tab in `WorkspaceTabs` (`content/[contentId]/page.tsx`):

- one compact row per job: stage, scene number, status pill, attempt `n/max`, model, cost,
  error text and group (§4), Resume/Cancel when they apply;
- expand: event list (from → to, attempt, event type, error code, local time), and for clips the
  provider status and poll count already shown on the clips tab;
- filters: stage, failed only. Polls (the existing `AutoRefresh`) while any job is active.

No new run page: the Activity tab and the Operations page cover runs.

## 6. Unknown outcomes of synchronous calls (W5, W6)

**Today.** The OpenRouter adapters mark a timeout or a network error after sending as
`outcome: unknown` (`packages/ai-core/src/openrouter/provider.ts:157`, `tts-provider.ts:126`,
`image-provider.ts:131`). The invocation is recorded `outcome_unknown`, but the error code is
transient, so `generation-processor.ts:767` retries it (up to 3 attempts). Only video ends the
job instead (`SUBMIT_OUTCOME_UNKNOWN`, `media-jobs.ts:180`).

**Change (worker, two shared lists).**

1. `generation-processor.ts`, provider-error branch: when `error.outcome === unknown` and the
   job kind is `script_generation`, `storyboard_generation` or `tts_generation`, count the circuit
   failure as today, then `failFinal(job, 'CALL_OUTCOME_UNKNOWN', 'the provider call could not be
confirmed; resuming may be charged twice')`. A failure in the repair call of a text job is
   treated the same way.
2. `packages/ai-runtime/src/budget-ledger.ts`: `HELD_ERROR_CODES` adds `CALL_OUTCOME_UNKNOWN`,
   so the reservation is held and appears on the Operations page for an owner to settle or release.
3. `resume.service.ts`: the outcome-unknown check becomes the same set (`SUBMIT_OUTCOME_UNKNOWN`,
   `CALL_OUTCOME_UNKNOWN`); skip reason `outcome_unknown` is unchanged, so the contract does not
   change.
4. Images (`image_generation`) keep today's retry (W6). If the owner prefers, the same rule can
   apply to images by adding the kind in step 1 (one line).
5. `docs/KNOWN_LIMITATIONS.md` and `docs/COST_STRATEGY.md` §6 describe the rule.

Effect on cost: at most one paid attempt per job after an unknown outcome; the reserved amount
keeps counting against the budget until an owner resolves it. Effect on users: a timed-out
script or voice-over needs a Resume (with consent) instead of retrying on its own.

## 7. Tests

| Level                 | New or changed tests                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (web)            | `job-errors` covers every `JobErrorCode`; resume dialog state machine (each response → next request body)                                                                                                       |
| Unit (domain/runtime) | `reservationOutcomeFor('CALL_OUTCOME_UNKNOWN') === 'held'`                                                                                                                                                      |
| Worker integration    | LLM timeout (`processor.integration.test.ts`): one call, `CALL_OUTCOME_UNKNOWN`, reservation held; TTS timeout (`media-processor.integration.test.ts`): same; image timeout still retried                       |
| API integration       | `GET /content/:id/jobs` (paging, filters, viewer access, project isolation, `storyboardSceneId`); resume of video jobs with/without `confirmedEstimateUsd`; resume skips `CALL_OUTCOME_UNKNOWN` without consent |
| Permission matrix     | New route for five callers                                                                                                                                                                                      |
| E2E                   | Clip resume with confirmation; cancel a running job; Activity tab expand                                                                                                                                        |

All with mock providers; no paid calls.

## 8. Implementation plan (each slice tested before the next)

| Slice | Content                                                | Changes                                         |
| ----- | ------------------------------------------------------ | ----------------------------------------------- |
| P3a   | W3 error catalogue; W1 resume confirmations; W2 cancel | contracts (const), worker (types), web          |
| P3b   | W4 Activity tab and `GET /content/:contentId/jobs`     | API (additive), contracts (optional field), web |
| P3c   | W5/W6 unknown-outcome hold; docs                       | worker, ai-runtime, API resume, docs            |

P3c is last because it changes runtime behaviour; P3a and P3b only expose existing behaviour.

## 9. Risks

- **More manual steps:** a timed-out script now waits for a Resume. Mitigated by the clear
  "Possibly charged" text and the one-click consent; text calls are cheap and rarely time out
  (`OPENROUTER_TIMEOUT_MS` 120 s).
- **Held reservations pile up** if owners ignore them: they already appear on Operations with
  Settle/Release; the 80 % budget warning still fires.
- **Typed error codes** may surface codes the worker emits that nobody listed; the typecheck
  finds them during P3a, which is the point.
- **Not covered:** a worker that dies in the middle of an LLM or TTS call; the reconciler requeues
  the job (`WORKER_LOST`) and the abandoned invocation is later marked `outcome_unknown`. Rare;
  left as is and listed in `KNOWN_LIMITATIONS.md`.
- **Resume of mixed runs:** a run holds one batch kind today; if that changes, the dialog asks
  per request in sequence (bounded to three rounds).
