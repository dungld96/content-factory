# ADR-0013: Generation jobs, queue and worker process

- Status: Proposed (M3 design package, revision 1)
- Date: 2026-11-18
- Milestone: M3

## Context

M3 introduces the first expensive operations driven by users (script and storyboard generation).
CLAUDE.md requires them to be asynchronous, idempotent and traceable jobs; ADR-0003 fixes BullMQ
as transport with PostgreSQL as the source of truth. The owner chose a separate `apps/worker`
process (decision F1).

## Decision

1. **Job intent first.** `generation_jobs` (+ append-only `job_events`) is written in PostgreSQL
   before enqueueing. The BullMQ payload carries only the job id, which is also the BullMQ job id
   (duplicate adds are no-ops).
2. **Outbox equivalent.** A worker reconciler enqueues `queued` jobs missing from Redis and
   recovers `running` jobs whose worker vanished, so a Redis outage or crash loses no work.
3. **Retries.** At most 3 attempts, exponential backoff with jitter; non-retryable provider errors,
   routing errors and invalid output stop immediately (`UnrecoverableError`). Exhausted jobs are
   `failed` in PostgreSQL and copied to a dead-letter queue.
4. **Idempotency.** Execution keys over all inputs (including prompt template version and model)
   let identical work reuse the existing successful result; client idempotency keys dedupe HTTP
   retries; each LLM call carries `{jobId}:{attempt}:{call}`.
5. **Process layout.** `apps/worker` is a Nest application context without HTTP. Shared LLM
   runtime code moves to `packages/ai-runtime` so API and worker use the same implementation.
6. **Dependency.** `bullmq@6.7.7` with the existing `ioredis@6.0.0` connection.

## Consequences

- Two deployables (API, worker) from one repository; both need Redis and PostgreSQL.
- Costs are recorded per attempt; retries after timeouts can cost twice (visible, bounded).
- Budget enforcement (M7) will hook into job creation.

## Alternatives considered

- Consumer inside the API process: one deployable, but expensive work competes with request
  handling and contradicts ARCHITECTURE §1 (rejected by the owner, F1).
- PostgreSQL-backed queue: fewer moving parts; BullMQ is fixed by the technology baseline (ADR-0003).
