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
| `pnpm test:integration`             | Readiness against real PostgreSQL and Redis (requires `pnpm infra:up`) |
| `pnpm test:coverage`                | Unit tests with V8 coverage                                            |
| `pnpm build`                        | Builds all packages and apps (`next build`, `nest build`)              |
| `pnpm check`                        | format:check + lint + typecheck + test + build (run before pushing)    |

## Database (Prisma 7)

| Command            | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `pnpm db:generate` | Generates the Prisma client into `packages/database/src/generated` (git-ignored) |
| `pnpm db:validate` | Validates `packages/database/prisma/schema.prisma`                               |
| `pnpm db:migrate`  | `prisma migrate dev`: creates and applies a migration (no models exist until M1) |
| `pnpm db:studio`   | Prisma Studio                                                                    |

The Prisma CLI reads `DATABASE_URL` from the repository-root `.env` (`packages/database/prisma.config.ts`).

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
