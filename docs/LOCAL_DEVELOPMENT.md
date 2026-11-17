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

`pnpm infra:up` starts PostgreSQL 17 and Redis 7.4 (`infra/compose/docker-compose.yml`) and waits
until both are healthy. The ports are bound to `127.0.0.1` only.

```bash
pnpm db:setup
```

`pnpm db:setup` creates the database roles `acf_migrator` (schema owner) and `acf_app` (runtime,
DML only) from the URLs in `.env`, makes `acf_migrator` the owner of the `acf` and `acf_shadow`
databases, applies the migrations as `acf_migrator`, and grants `acf_app` access. It is
idempotent: run it again after pulling new migrations. See `docs/DATABASE.md` §8.

```bash
pnpm env:check
```

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
- **`permission denied` or `password authentication failed for user "acf_app"`**: run
  `pnpm db:setup`. Existing `.env` files from M0 must add `DATABASE_ADMIN_URL`,
  `DATABASE_MIGRATION_URL` and `DATABASE_SHADOW_URL`, and point `DATABASE_URL` at `acf_app`
  (compare with `.env.example`).
