# ADR-0022: Live job events over Server-Sent Events, read from PostgreSQL

- Status: Accepted (owner decision R-D5, 2026-11-23: "the most performance-efficient way")
- Date: 2026-11-23
- Milestone: post-MVP redesign (docs/design/R-redesign-package.md §5)

## Context

The studio followed running work by polling: the content workspace called `router.refresh()`
every two seconds while generating, the Activity tab polled the job list every three seconds, and
each Generate button polled its job. Every open tab polled on its own, there was no global view of
running jobs, and leaving a page lost track of its jobs.

## Decision

1. **Transport: Server-Sent Events** (`GET /api/v1/events`), one-way, same origin, through the
   existing Next.js `/api/v1/*` rewrite and Caddy. No WebSocket server and no new dependency.
2. **Source: `job_events` in PostgreSQL**, read after commit. One tailer per API process reads new
   rows once a second, and only while at least one stream is open, then fans them out in memory
   to the open streams, filtered to each user's projects. The database cost is one indexed query
   per second per API process, independent of the number of browsers. The worker is unchanged.
   Redis is not on the path, so a Redis outage loses no event; Redis pub/sub wake-ups are the
   follow-up if the API ever runs as several processes.
3. **Resumable**: event ids are cursors (`<createdAt ms>-<event id>`); a reconnect with
   `Last-Event-ID` (or `?since=`) receives what it missed; a gap over 15 minutes or 1,000 events
   sends `resync`. Readers re-read a 5-second overlap (ids are made before commit) and clients
   de-duplicate by id.
4. **One connection per browser**: the tab holding the Web Lock `acf-live` keeps the only
   `EventSource` and repeats events on a `BroadcastChannel`; other tabs listen. With every tab
   hidden for two minutes the stream pauses and resumes by cursor.
5. **Fallback**: `GET /api/v1/jobs/changes?since=` with `ETag`/`304`, polled every 3 s with active
   jobs, 15 s idle, 60 s hidden, with exponential backoff and jitter, when the stream fails three
   times or is silent for 60 s (heartbeat every 25 s); the stream is tried again every 5 minutes.
6. **One client store** (`useSyncExternalStore`) feeds the Jobs tray, the workspace and the job
   list; pages re-render their server data once per burst of events (debounced
   `router.refresh()`), never on a timer.

## Consequences

- Latency of a state change in the browser: about one second plus network.
- PostgreSQL stays the source of truth (ADR-0002); `job_events` gains an index on `created_at`.
- Proxies must not buffer the stream: the API sends `Cache-Control: no-cache, no-transform` and
  `X-Accel-Buffering: no`; Caddy flushes event streams. If a proxy still buffers, the client falls
  back to polling on its own.
- Only job state changes are pushed. Other changes (approvals, selections) re-render the page of
  the person who made them; other viewers see them on their next navigation or job event.
