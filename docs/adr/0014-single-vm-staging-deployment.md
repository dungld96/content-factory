# ADR-0014: Single-VM staging deployment on Google Cloud

- Status: Accepted (owner chose option A, 2026-11-18); **Google Cloud parts superseded by
  ADR-0021** (generic Ubuntu VPS, 2026-11-20). The single-server Docker Compose topology stands.
- Date: 2026-11-18
- Milestone: none (staging environment to try M3; outside the milestone plan)

## Context

The owner wants to try the platform on Google Cloud after M3. The repository had only a local
`docker-compose.yml` for PostgreSQL and Redis, no application images and no deployment
configuration. Two options were presented: (A) one Compute Engine VM running Docker Compose,
(B) managed services (Cloud Run, Cloud SQL, Memorystore). B has fixed costs even when idle
(Memorystore, Cloud SQL, an always-on worker) and needs VPC, secret and migration work that is
premature before the production pilot (ARCHITECTURE §10). The owner chose A.

## Decision

1. **One image** (`infra/deploy/Dockerfile`, `node:22.23.4-bookworm-slim`, pnpm 10.28.0) holds the
   built monorepo. The API, worker, web and the one-off `migrate` tool are compose services with
   different working directories and commands. It keeps dev dependencies (the Prisma CLI runs
   migrations); a slimmer runtime image is not a goal for staging.
2. **Topology** (`infra/deploy/docker-compose.yml`): PostgreSQL 17.12 and Redis 7.4.12 on an
   internal network with no published ports; Caddy 2.10.2 is the only public entry (80/443) and
   terminates TLS with automatic certificates; Next.js forwards `/api/v1/*` to the API
   (same-origin topology, ADR-0009). The API is not reachable from outside.
3. **Proxy trust:** web and Caddy have fixed internal addresses; `TRUST_PROXY` names exactly
   those. Caddy overwrites client-supplied `X-Forwarded-*`. `NODE_ENV=production` enforces
   `Secure` `__Host-` cookies.
4. **Secrets:** `infra/deploy/generate-env.sh` writes `.env.production` (mode 600, git-ignored)
   with random database passwords and session/CSRF secrets. Each service receives only the
   variables it needs; only `migrate` gets the admin and migrator URLs. The OpenRouter key stays
   in API and worker containers.
5. **Database:** the `migrate` tool runs the existing `db-setup.mjs setup` (roles, migrations,
   grants). This is acceptable for a self-hosted staging database; a managed production database
   needs its own procedure (open item).
6. **Demo data:** the development seed may be run once, explicitly, with `NODE_ENV=development`
   on the `migrate` tool, because the web UI cannot yet create projects or content items.
7. **No test code in the image's runtime path:** the fixture LLM is not wired; generation needs a
   real provider (OpenRouter) routed with the registry CLI.

## Consequences

- Cheap, close to local development, can be stopped when unused; one machine to patch and back
  up by hand (`pg_dump`, documented). No autoscaling or high availability.
- Building the image on the VM needs about 4 GB of memory (e2-medium plus swap).
- Moving to option B later reuses the image; the compose file is staging-only.

## Alternatives considered

- **Option B (Cloud Run + Cloud SQL + Memorystore):** deferred to the production pilot.
- **Separate slim images per app (`pnpm deploy`):** smaller, but more build configuration;
  not needed for staging.
- **Shipping the fixture LLM as a demo mode:** rejected without an explicit owner decision; it
  would put test-only code on a public server.
