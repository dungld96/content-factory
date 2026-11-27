# M8b hardening record (2026-11-20)

Drills run with `pnpm test:drills` (part of `pnpm test:integration`); all pass, and the two
BullMQ drills passed three runs in a row.

| Drill                                         | Test                                                                    | Result                                                                                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider outage (circuit) through real BullMQ | `apps/worker/test/drills.integration.test.ts`                           | Two outages open the circuit; the next delivery is **deferred via `moveToDelayed` without an attempt**; the half-open trial succeeds; 3 provider calls, 3 attempts; events `closed>open`, `open>half_open`, `half_open>closed` |
| Redis loses every queue key                   | same file                                                               | Queued, running and never-enqueued jobs all finish **once** after one reconciler pass (2 enqueued, 1 requeued as attempt 2); a second pass finds nothing                                                                       |
| Worker dies mid-render                        | `apps/worker/test/render-processor.integration.test.ts`                 | Redelivery recovers the stalled job as attempt 2; one render, exactly one set of outputs (video, captions, thumbnail), all referenced by the render                                                                            |
| Worker dies during a text job                 | existing: `queue.integration.test.ts` (reconciler)                      | Requeued as a new attempt; one result                                                                                                                                                                                          |
| Worker dies after a video submit              | existing: `media-processor.integration.test.ts`                         | Never resubmitted; polling resumes; `SUBMIT_OUTCOME_UNKNOWN` when the submit itself was interrupted                                                                                                                            |
| Restore                                       | M8a: `apps/api/test/ops/backup.integration.test.ts`, `restore-drill.md` | Passed                                                                                                                                                                                                                         |

Notes: an interrupted render or image attempt can leave already-uploaded objects without a database
row (content-addressed, harmless, not served); they cost only storage and are listed in the known
limitations.

## Dependency audit

`pnpm audit` (production and development dependencies): **1 high**, GHSA-7589-6fvf-x4pw (ReDoS in
`effect` ≤ 3.22.0), reached only through `prisma` → `@prisma/config`, which pins `effect` 3.20.0
and parses our own static `prisma.config.ts`. Fixed with a pinned pnpm override to `effect` 3.22.4
(same major, published 2026-10-22); Prisma validate, generate and migrate status verified. After
the fix: **no known vulnerabilities**. Remove the override once Prisma pins a patched version.

## Production configuration review

| Item                      | Finding                                                                                            | Action                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Security headers on pages | Only the API (helmet) set them; Next.js pages had no `X-Frame-Options`/`nosniff`/`Referrer-Policy` | **Fixed** in the Caddyfile for every response (validated with `caddy validate`, Caddy 2.10.2) |
| Content-Security-Policy   | None on pages (Next.js inline scripts need nonces)                                                 | Known limitation                                                                              |
| HTTPS / HSTS              | Caddy automatic certificates; HSTS 1 year                                                          | ok                                                                                            |
| Session cookie            | `HttpOnly`, `SameSite=Lax`, `Secure` in production                                                 | ok                                                                                            |
| CSRF, CORS                | Double-submit token on every mutation; CORS limited to the site origin                             | ok                                                                                            |
| Login rate limit          | 10 per minute per client (`LOGIN_RATE_LIMIT_PER_MINUTE`)                                           | ok                                                                                            |
| Upload and body limits    | Images 25 MB, proxy body 26 MB, audio limit enforced by the API                                    | ok                                                                                            |
| Generated production env  | `generate-env.sh` output validated by the API's env schema with the compose values                 | ok: secure cookies, budget defaults 10/3/2, all storage keys present                          |
| Exposure                  | Only Caddy publishes ports; API, database, Redis, storage on the internal network                  | ok                                                                                            |
| Secrets in logs           | M7 redaction sweep                                                                                 | ok                                                                                            |
