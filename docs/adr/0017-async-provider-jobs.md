# ADR-0017: Asynchronous provider jobs (video) and text-to-speech

- Status: Accepted (M5 design package revision 1, approved 2026-11-19; implemented in M5a–M5e)
- Date: 2026-11-19
- Milestone: M5

## Context

M5 adds scene clips and voice-overs. Video generation is the first **asynchronous** provider
call: the OpenRouter Video API accepts a job (`POST /videos` → id), runs it for minutes, and is
polled (`GET /videos/{id}`) until it is `completed`, `failed`, `cancelled` or `expired`. It has no
idempotency key and no cancel endpoint, and every accepted job is charged. Text-to-speech
(`/audio/speech`) is synchronous and cheap. Verification record:
`docs/design/m5/openrouter-video-tts-verification.md`.

## Decision

1. **Submit once (decision V3).** The worker records the submission intent (`submitted_at`,
   ledger invocation, adapter) in PostgreSQL immediately before the paid call, and the provider
   job id immediately after it. A submission that may have reached the provider (timeout, lost
   response, worker crash during the call) is **never resent**: the job fails with
   `SUBMIT_OUTCOME_UNKNOWN`, the invocation is `outcome_unknown`, and the user decides whether to
   regenerate (which may be charged twice). A submission the provider refused (`REJECTED`, not
   sent) clears the intent and is retried within the attempt budget. The database freezes the
   provider job id and intent once recorded (`AC011`).
2. **Polls are delayed BullMQ jobs.** Each status read is its own job (`poll`, id
   `{jobId}-poll-{n}`, one attempt) on the `generation-video` queue, scheduled 15 s, 30 s, 60 s,
   then +60 s up to 5 minutes; no worker sleeps. Polls are free and not counted as attempts. A
   restarted worker, or the reconciler finding no live poll, schedules the next one; a running
   job with an intent but no provider job id is delivered once more so the processor records the
   unknown outcome. The provider bounds its own jobs (`expired`); the worker stops following one
   after 6 h (`PROVIDER_TIMEOUT`). "Check again" runs the pending poll immediately.
3. **Downloads are validated before they count.** A completed clip is streamed to a temporary
   file (≤ 200 MB), checked with FFprobe (container, codec, aspect ratio, duration), stored
   write-once, and recorded as a `generated` video asset with its keyframe in `asset_inputs` and
   the provider's reported (else estimated) cost, in one transaction with the job's success.
   An invalid or expired output is a final failure with its cost recorded, never a resubmission.
4. **TTS is synchronous**, routed only to zero-data-retention endpoints (decision V2), validated
   with FFprobe, and retried by the M3 policy. Voice parameters come from a project voice
   profile and are snapshotted into each job.
5. **Spend guard until M7.** A video generate request needs the estimate the user saw
   (`confirmedEstimateUsd`) and is refused above `VIDEO_MAX_ESTIMATED_USD_PER_REQUEST`.
6. **Selection is enforced by the database.** Each scene's clip and voice-over (gate 4) are
   approved, active media of the scene (`AC016`); a new keyframe clears the scene's clip.

## Consequences

- Restarts never cause a second paid submission; the cost of an ambiguous submit is visible as
  `outcome_unknown` instead of being guessed.
- Canceling our job only stops following it; the invocation becomes `outcome_unknown` because the
  provider may still charge.
- Video inputs (prompts, keyframes) are retained by the provider (no zero-data-retention for
  video; risk R1 accepted by the owner).
- Worker and API need FFprobe/FFmpeg (deploy image, CI); without them media features answer
  `503 MEDIA_TOOLS_MISSING`.

## Alternatives considered

- **Resubmit on any error, like synchronous calls.** Rejected: no idempotency key, so a lost
  response would be charged twice without anyone deciding it.
- **Hold the worker on a sleeping loop until the clip is ready.** Rejected: ties up concurrency
  for minutes per clip and loses the loop on restart.
- **Provider webhooks.** Not offered by the verified API; polling is free.
