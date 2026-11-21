# ADR-0003: BullMQ/Redis for background execution

- Status: Accepted
- Date: 2026-11-17
- Milestone: M0 (infrastructure only; first queue in M2/M3)

## Context

All expensive operations (LLM, image, video, TTS, rendering) must be asynchronous, retryable with
bounded backoff, and must not hold HTTP requests open.

## Decision

- BullMQ on Redis is the job transport. Redis is **not** the source of truth (ADR-0002).
- Flow: persist job intent + idempotency key in PostgreSQL → enqueue a job carrying only IDs →
  worker loads state from PostgreSQL, records state transitions, and writes results back.
- Use an outbox (or equivalent) if DB commit and enqueue must be atomic.
- Bounded retries with exponential backoff and jitter; no retry for invalid input, policy blocks,
  authentication failures or budget blocks; dead-letter after exhaustion.
- Local Redis runs with `--maxmemory-policy noeviction` (required by BullMQ) and AOF enabled.
- M0: Redis is provisioned and checked by the API readiness probe through `ioredis`. No queues yet.

## Consequences

- A Redis outage pauses work but loses no production state; workers resume from PostgreSQL.
- Managed Redis in production must allow `noeviction`.

## Alternatives considered

- PostgreSQL-backed queues (pg-boss, Graphile Worker) — fewer moving parts, but BullMQ is fixed in
  the technology baseline. Revisit only with measured need.
