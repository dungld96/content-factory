# Local Development

Exact commands to run the platform locally. Every command runs from the repository root.

## Prerequisites

| Tool                | Version                                     | Check                            |
| ------------------- | ------------------------------------------- | -------------------------------- |
| Node.js             | ≥ 22.12 (see `.nvmrc`)                      | `node -v`                        |
| pnpm                | 10.x (pinned via `packageManager`: 10.28.0) | `pnpm -v` (or `corepack enable`) |
| Docker + Compose v2 | recent                                      | `docker compose version`         |

## First-time setup

```bash
cp .env.example .env
```

```bash
pnpm install
```

```bash
pnpm infra:up
```

`pnpm infra:up` starts PostgreSQL 17, Redis 7.4 and SeaweedFS 4.54 (S3-compatible object storage
for asset files, M4a) from `infra/compose/docker-compose.yml` and waits until all are healthy. The
ports are bound to `127.0.0.1` only (SeaweedFS S3: 8333).

```bash
pnpm db:setup
```

`pnpm db:setup` creates the database roles `acf_migrator` (schema owner) and `acf_app` (runtime,
DML only) from the URLs in `.env`, makes `acf_migrator` the owner of the `acf` and `acf_shadow`
databases, applies the migrations as `acf_migrator`, and grants `acf_app` access. It is
idempotent: run it again after pulling new migrations. See `docs/DATABASE.md` §8.

Create the asset bucket (`S3_BUCKET`) with the storage admin key from `.env`. Idempotent:

```bash
pnpm storage:setup
```

```bash
pnpm env:check
```

For a ready-made demo workspace (development only), seed it. This creates
`owner@demo.acf.test`, `editor@demo.acf.test` and `viewer@demo.acf.test` with random passwords
(printed once), and a "Demo Studio" project with a channel, a content brief, a reference asset,
and a character and an environment that each have an approved master version. It does nothing if
the demo users already exist, and refuses to run with `NODE_ENV=production`:

```bash
pnpm db:seed
```

Then sign in at http://localhost:3000/login.

Or create your own account (there is no sign-up page; decision D6). The CLI asks for the password
without echoing it (or reads it from a pipe) and never accepts it as an argument:

```bash
pnpm user:create --email you@example.com --name "Your Name"
```

| Command                                    | What it does                                                 |
| ------------------------------------------ | ------------------------------------------------------------ |
| `pnpm user:create --email … --name …`      | Creates an active user (password ≥ 12 characters)            |
| `pnpm user:set-password --email …`         | Sets a new password and revokes all of the user's sessions   |
| `pnpm user:disable --email …`              | Disables the account and revokes all of its sessions         |

Authentication settings live in `.env` (`SESSION_SECRETS`, `CSRF_SECRET`,
`SESSION_COOKIE_SECURE`, `TRUST_PROXY`, `WEB_ORIGINS`; see `.env.example`). Generate each secret
with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
Production requires `SESSION_COOKIE_SECURE=true` and a `TRUST_PROXY` that names the Next.js hop;
the TLS proxy in front of Next.js must overwrite `X-Forwarded-Proto`, and the API must not be
publicly reachable.

## Run the apps

To run the API and web together (this builds the shared packages first):

```bash
pnpm dev
```

Or run them in separate terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

Both apps read the repository-root `.env` automatically. Variables already set in the shell take
precedence. The API validates its environment at startup and exits with a list of the invalid
variable names.

| URL                                       | What                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| http://localhost:3000                     | Web shell                                                   |
| http://localhost:3000/status              | System status page (server-side call to API readiness)      |
| http://localhost:4000/api/v1/health       | API liveness                                                |
| http://localhost:4000/api/v1/health/ready | API readiness (PostgreSQL + Redis); `503` if either is down |

To check by hand:

```bash
curl -s localhost:4000/api/v1/health/ready
```

## Quality checks

| Command                             | What it does                                                           |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm lint`                         | ESLint (type-aware), zero warnings allowed                             |
| `pnpm format` / `pnpm format:check` | Prettier write / check                                                 |
| `pnpm typecheck`                    | Builds shared packages, then `tsc --noEmit` in every workspace         |
| `pnpm test`                         | Unit and HTTP tests with mocked dependencies (no Docker, no network)   |
| `pnpm test:integration`             | Integration tests against real PostgreSQL and Redis (requires `pnpm infra:up` and `pnpm db:setup`) |
| `pnpm test:e2e`                     | Playwright in Chromium against the built API, worker and web (requires `pnpm build`, PostgreSQL, Redis) |
| `pnpm test:coverage`                | Unit tests with V8 coverage                                            |
| `pnpm build`                        | Builds all packages and apps (`next build`, `nest build`)              |
| `pnpm check`                        | format:check + lint + typecheck + test + build (run before pushing)    |

## Database (Prisma 7)

| Command                  | What it does                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `pnpm db:setup`          | Roles, databases and grants, then `prisma migrate deploy`, then grants again (idempotent)      |
| `pnpm db:bootstrap`      | Roles, databases and grants only                                                               |
| `pnpm db:generate`       | Generates the Prisma client into `packages/database/src/generated` (git-ignored)               |
| `pnpm db:validate`       | Validates `packages/database/prisma/schema.prisma`                                             |
| `pnpm db:migrate`        | `prisma migrate dev`: creates and applies a migration (uses the `acf_shadow` database)         |
| `pnpm db:migrate:deploy` | Applies pending migrations without creating new ones                                           |
| `pnpm db:studio`         | Prisma Studio                                                                                  |

Connection URLs (all in the repository-root `.env`):

| Variable                 | Role           | Used by                                                       |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| `DATABASE_URL`           | `acf_app`      | The API (DML only)                                            |
| `DATABASE_MIGRATION_URL` | `acf_migrator` | The Prisma CLI (`packages/database/prisma.config.ts`)         |
| `DATABASE_SHADOW_URL`    | `acf_migrator` | `prisma migrate dev` shadow database                          |
| `DATABASE_ADMIN_URL`     | superuser      | `pnpm db:setup` and the integration-test setup only           |

The M1 migration ends with hand-written SQL (CHECK constraints, functions and triggers) that
Prisma does not model. When you create a migration that touches a guarded table, keep the
triggers intact; the `integration:database` tests fail if any trigger or CHECK is missing or if
the database drifts from `schema.prisma`.

### Object storage (M4a)

Asset files (uploaded references, generated images) live in S3-compatible storage — SeaweedFS
locally, in CI and on staging (ADR-0006, amended). The API and worker use `S3_ENDPOINT`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (all or none; without them uploads and
image generation answer `503 STORAGE_NOT_CONFIGURED`). `STORAGE_ADMIN_*` is used only by
`pnpm storage:setup` and the integration-test setup. Browsers never talk to storage: uploads are
`POST /api/v1/projects/:projectId/assets/upload` (raw image body, ≤ 25 MB) and reads are
`GET /api/v1/assets/:assetId/content`. `pnpm test:integration` includes `integration:storage`
(bucket `acf-test-storage`); the API tests use `acf-test-api`.

### Worker (M3)

Generation jobs (scripts, storyboards) run in a separate process, `apps/worker` (ADR-0013):

```bash
pnpm dev:worker
```

It needs `DATABASE_URL`, `REDIS_URL` and, for real models, `OPENROUTER_API_KEY` (validated by
`packages/config/src/worker-env.ts`; `WORKER_CONCURRENCY`, `WORKER_RECONCILE_INTERVAL_MS` and
`QUEUE_PREFIX` are optional). PostgreSQL is the source of truth: if Redis was down when a job was
created, the worker's reconciler enqueues it within a minute. `pnpm test:integration` includes
`integration:worker` (its own `acf_test_worker` database and a unique Redis key prefix).

### AI registry and providers (M2)

`pnpm db:seed` also seeds the AI registry: the `openrouter` provider (enabled only if
`OPENROUTER_API_KEY` is set when it is first seeded), three OpenRouter models with the
2026-11-17 catalog prices (all **disabled**: none is benchmarked or terms-reviewed), and a
`mock` provider with a zero-priced `mock/echo` model for development.

`OPENROUTER_API_KEY` is optional; without it the provider reports `configured: false` and is
never called. Tests never need it and cannot reach `openrouter.ai` (network guard in
`test-support/network-guard.ts`).

| Command | What it does |
|---|---|
| `pnpm ai:registry provider list` | Providers with kind and status |
| `pnpm ai:registry provider set-status <key> <enabled\|disabled\|degraded>` | Change a provider's status |
| `pnpm ai:registry model list` | Models with status, tier and active prices |
| `pnpm ai:registry model import-openrouter <modelKey>... [--tier <tier>] [--apply]` | Reads OpenRouter's public catalog and prints a plan; with `--apply`, creates new models **disabled** (a tier is required) and appends a price row only for a changed published price |
| `pnpm ai:registry model set-status <modelKey> <status>` | Enable/disable a model |
| `pnpm ai:registry price add <modelKey> <metric> <usdPerUnit> --source <source> --url <url>` | Append a price row (rows are never edited) |
| `pnpm ai:registry route list` / `route set <script_generation\|storyboard_generation> <modelKey> [--provider <key>]` | Which model each generation task uses (M3); `pnpm db:seed` routes both to `mock/echo` |
| `pnpm ai:registry invocations mark-abandoned` | Marks invocations stuck in `started` past every deadline as `outcome_unknown` (never re-sent) |
| `ACF_PAID_SMOKE=1 pnpm ai:registry smoke <modelKey> --project <slug> --max-cost-usd <usd>` | **One real, paid call.** Refused unless enabled, a key is set, input and output prices are known, and the worst case (fixed tiny prompt, 16 output tokens) is within the cap. Prints reported vs estimated cost to check assumptions A1–A3 |

Behind an HTTPS proxy, Node's built-in `fetch` (catalog import, smoke test) ignores
`HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (and `NODE_EXTRA_CA_CERTS` for a custom CA);
without it the import reports that the catalog could not be reached.

Before enabling a model for real work: review its commercial terms, run the smoke test,
benchmark it (`docs/AI_PROVIDER_STRATEGY.md` §9), then `model set-status … enabled`.

### End-to-end tests (Playwright)

`pnpm test:e2e` runs `apps/web/e2e` in Chromium. Its global setup recreates a disposable
`acf_test_e2e` database from the migrations and seeds it with the real seed CLI; Playwright then
starts the production builds of the API (port 4100), the worker and web (port 3100), so they do
not clash with `pnpm dev`. The API and worker run through E2E entry points
(`apps/api/test/e2e/api-server.ts`, `apps/worker/test/e2e/worker-server.ts`, run by Node's type
stripping) that register a **fixture LLM** as the `mock` provider: schema-valid scripts and
storyboards, no network, no cost. Both use the queue prefix `acf-e2e`. Playwright starts web
servers before global setup, so the worker waits for a marker file that global setup writes once
the database is seeded (`apps/web/e2e/env.ts`).

Specs: `auth.spec.ts` (login, logout, sessions) and `pipeline.spec.ts` (editor: generate script →
edit → approve → generate storyboard → edit scene → approve; viewer: no generate, edit or review
controls). Build first, and install the browser once:

```bash
pnpm build
```

```bash
pnpm --filter @acf/web exec playwright install chromium
```

```bash
pnpm test:e2e
```

### Database integration tests

`pnpm test:integration` includes the `integration:database` project. Its global setup drops and
recreates a disposable `acf_test` database, runs `prisma migrate deploy` as `acf_migrator`, and the
tests connect as `acf_app`:

- `direct-sql`: every constraint and trigger rejects forbidden direct SQL with the exact SQLSTATE.
- `concurrency`: a deterministic two-session lock-boundary matrix (approval vs archive, owner
  changes, out-of-order and double approvals, session `set()` vs logout). Any deadlock (`40P01`)
  fails the test.
- `schema-objects`: trigger/CHECK presence, Prisma drift, and the `acf_app` privilege limits.
- `prisma-errors`: how Prisma surfaces the integrity errors (`databaseErrorInfo`).

The `integration:api` project builds its own disposable `acf_test_api` database the same way
and runs the real API on an ephemeral port: the session suite (expiry, fixation, CSRF, logout
races R1–R8), login/Origin/secure-cookie/throttling behaviour, and the user CLI service.

To run only these:

```bash
pnpm build:packages && pnpm vitest run --project integration:database
```

## Infrastructure lifecycle

| Command            | What it does                                        |
| ------------------ | --------------------------------------------------- |
| `pnpm infra:up`    | Start PostgreSQL and Redis and wait until healthy   |
| `pnpm infra:down`  | Stop the containers and keep the data volumes       |
| `pnpm infra:reset` | Stop the containers and **delete** the data volumes |
| `pnpm infra:logs`  | Follow the container logs                           |

## Production-style run (after `pnpm build`)

```bash
pnpm start:api
```

```bash
pnpm start:web
```

## Troubleshooting

- **`Invalid API environment configuration`**: compare `.env` with `.env.example`. The message
  lists each invalid variable by name.
- **Readiness `503` with `unreachable`**: run `pnpm infra:up` and check `docker compose ps`.
- **Port already in use**: change `POSTGRES_PORT`, `REDIS_PORT` or `API_PORT` in `.env`. If you
  change a port, update `DATABASE_URL` / `REDIS_URL` to match.
- **`Cannot find module '@acf/...'`**: the shared packages are not built yet. Run `pnpm build:packages`.
- **`Invalid API environment configuration` after pulling M1b**: add `SESSION_SECRETS` and
  `CSRF_SECRET` to `.env` (see `.env.example`).
- **`permission denied` or `password authentication failed for user "acf_app"`**: run
  `pnpm db:setup`. Existing `.env` files from M0 must add `DATABASE_ADMIN_URL`,
  `DATABASE_MIGRATION_URL` and `DATABASE_SHADOW_URL`, and point `DATABASE_URL` at `acf_app`
  (compare with `.env.example`).
