# Local Development

Every command runs from the repository root.

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | ≥ 22.12 (`.nvmrc`) | `node -v` |
| pnpm | 10.x (pinned: 10.28.0) | `pnpm -v` (or `corepack enable`) |
| Docker + Compose v2 | recent | `docker compose version` |
| FFmpeg + FFprobe | ≥ 5.1 with libx264 and libmp3lame | `ffprobe -version` |

FFmpeg validates audio and video, renders the final video, and lets the mock providers make real
test files. Install it with your package manager (`apt-get install ffmpeg`, `brew install ffmpeg`).
Without it, media features answer `503 MEDIA_TOOLS_MISSING`; set `FFPROBE_PATH`/`FFMPEG_PATH` if
the binaries are not on `PATH`. The worker checks both tools when it starts and before every paid
clip or voice-over call: while one is missing, those jobs end with `MEDIA_TOOLS_MISSING` **before**
anything is sent to a provider, so nothing is charged. After installing, resume the job; the
worker needs no restart.

### Windows (`pnpm dev`, no Docker for the apps)

The apps run natively on Windows; only PostgreSQL, Redis and SeaweedFS need Docker Desktop (or
native installs listening on the ports in `.env`).

1. Install FFmpeg (includes FFprobe), in PowerShell:

   ```powershell
   winget install --id Gyan.FFmpeg -e
   ```

   Open a **new** terminal so `PATH` is refreshed, then check `ffmpeg -version` and
   `ffprobe -version`.
2. If the tools are not on `PATH` (portable ZIP, or `winget` without a shell restart), set full
   paths in `.env`, with forward slashes:

   ```dotenv
   FFMPEG_PATH=C:/ffmpeg/bin/ffmpeg.exe
   FFPROBE_PATH=C:/ffmpeg/bin/ffprobe.exe
   ```
3. Check the render pipeline end to end: `pnpm media:selftest` (prints `✔ render self-test
   passed`).
4. Start the worker (`pnpm dev:worker`). Its start-up log shows the FFmpeg and FFprobe versions,
   or a `media_tools_missing` error with what to fix.

## 2. First-time setup

```bash
cp .env.example .env
```

```bash
pnpm install
```

Start PostgreSQL 17, Redis 7.4 and SeaweedFS 4.54 (S3 storage) and wait until healthy. Ports are
bound to `127.0.0.1` only:

```bash
pnpm infra:up
```

Create the database roles, apply migrations and grant access (idempotent; run again after pulling
new migrations; see `docs/DATABASE.md` §8):

```bash
pnpm db:setup
```

Create the asset bucket (idempotent):

```bash
pnpm storage:setup
```

Check the environment:

```bash
pnpm env:check
```

Seed a demo workspace (development only). It creates `owner@`, `editor@` and `viewer@demo.acf.test`
with random passwords (printed once), a "Demo Studio" project with a channel, a brief, a
reference asset, a character and an environment, and the AI registry with free mock models:

```bash
pnpm db:seed
```

Or create your own account (no sign-up page). The password is read from the terminal, never from
arguments:

```bash
pnpm user:create --email you@example.com --name "Your Name"
```

Other user commands: `pnpm user:set-password --email …` (revokes all sessions) and
`pnpm user:disable --email …`.

Secrets in `.env` (`SESSION_SECRETS`, `CSRF_SECRET`; see `.env.example`) can be generated with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## 3. Run

API and web together (builds the shared packages first):

```bash
pnpm dev
```

The worker, needed for any generation or rendering:

```bash
pnpm dev:worker
```

Or each on its own: `pnpm dev:api`, `pnpm dev:web`. All apps read the root `.env`; shell
variables take precedence. Each app validates its environment at startup and lists invalid
variable names.

| URL | What |
|---|---|
| http://localhost:3000 | Content Studio (sign in at `/login`) |
| http://localhost:3000/status | System status |
| http://localhost:4000/api/v1/health | API liveness |
| http://localhost:4000/api/v1/health/ready | API readiness (PostgreSQL + Redis); `503` if either is down |
| http://localhost:4000/api/v1/openapi.json | OpenAPI document (outside production) |

Production-style run after `pnpm build`: `pnpm start:api`, `pnpm start:web`, `pnpm start:worker`.

## 4. Quality checks

| Command | What it does |
|---|---|
| `pnpm check` | format:check + lint + typecheck + test + build (run before pushing) |
| `pnpm lint` | ESLint (type-aware), zero warnings |
| `pnpm format` / `format:check` | Prettier |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm test` | Unit, contract and HTTP tests (no Docker, no network) |
| `pnpm test:coverage` | Unit tests with coverage |
| `pnpm test:integration` | Against real PostgreSQL, Redis and SeaweedFS (needs `infra:up` and `db:setup`) |
| `pnpm test:drills` | Backup/restore drills only |
| `pnpm test:e2e` | Playwright against built apps (needs `pnpm build` and the infra) |
| `pnpm media:selftest` | Renders a short synthetic video and runs QC (no network, no cost) |
| `pnpm build` | Builds all packages and apps |

Tests never call real providers: `test-support/network-guard.ts` blocks outside hosts.

### Integration tests

Each project builds its own disposable database from the migrations
(`acf_test`, `acf_test_api`, `acf_test_worker`, …) and its own bucket and queue prefix:

- `integration:database`: every constraint and trigger, lock-order concurrency (any deadlock
  fails), schema drift and `acf_app` privilege limits.
- `integration:api`: the real API on an ephemeral port (sessions, CSRF, permissions, generation,
  budgets).
- `integration:worker`, `integration:storage`: jobs end to end with real Redis and SeaweedFS.

Run one project:

```bash
pnpm build:packages && pnpm vitest run --project integration:database
```

### End-to-end tests

`pnpm test:e2e` recreates an `acf_test_e2e` database, seeds it, and starts the production builds of
the API (port 4100), worker and web (port 3100) with **fixture models** (no network, no cost) and
queue prefix `acf-e2e`. Specs are in `apps/web/e2e/`. Install the browser once:

```bash
pnpm build
```

```bash
pnpm --filter @acf/web exec playwright install chromium
```

```bash
pnpm test:e2e
```

## 5. Database (Prisma 7)

| Command | What it does |
|---|---|
| `pnpm db:setup` | Roles, databases, grants, `prisma migrate deploy` (idempotent) |
| `pnpm db:bootstrap` | Roles, databases and grants only |
| `pnpm db:generate` | Generates the Prisma client (`packages/database/src/generated`, git-ignored) |
| `pnpm db:validate` | Validates `schema.prisma` |
| `pnpm db:migrate` | `prisma migrate dev`: creates and applies a migration (uses `acf_shadow`) |
| `pnpm db:migrate:deploy` | Applies pending migrations |
| `pnpm db:studio` | Prisma Studio |

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `acf_app` | API and worker (DML only) |
| `DATABASE_MIGRATION_URL` | `acf_migrator` | Prisma CLI, seed |
| `DATABASE_SHADOW_URL` | `acf_migrator` | `prisma migrate dev` shadow database |
| `DATABASE_ADMIN_URL` | superuser | `pnpm db:setup` and test setup only |

Migrations end with hand-written SQL (CHECKs, functions, triggers). Keep the triggers intact when
you change a guarded table; `integration:database` fails if one is missing (`docs/DATABASE.md` §5).

## 6. Object storage

Files live in SeaweedFS locally, in CI and on staging (ADR-0006). The API and worker need
`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (all or none; without
them uploads and generation answer `503 STORAGE_NOT_CONFIGURED`). `STORAGE_ADMIN_*` is used only by
`pnpm storage:setup` and test setup.

## 7. Worker

`apps/worker` needs `DATABASE_URL`, `REDIS_URL`, the S3 variables and, for real models,
`OPENROUTER_API_KEY`. Optional: `WORKER_CONCURRENCY`, `WORKER_RECONCILE_INTERVAL_MS`,
`QUEUE_PREFIX`. If Redis was down when a job was created, the reconciler enqueues it within a
minute.

## 8. AI registry

Operators (users listed in `OPERATOR_EMAILS` in `.env`) can also change provider and model status,
schema mode and routes in **Settings → AI providers & models**, and test the API key without a paid
call. Keys are never entered there.

`pnpm db:seed` seeds the `openrouter` provider (enabled only if `OPENROUTER_API_KEY` is set at
seed time), benchmark candidate models (all **disabled**), and the `mock` provider with free
models routed for every task: `mock/echo`, `mock/solid-image`, `mock/still-video`,
`mock/tone-tts`. Without a key, OpenRouter reports `configured: false` and is never called.

Operator CLI (`pnpm ai:registry …`):

| Command | What it does |
|---|---|
| `provider list` · `provider set-status <key> <enabled\|disabled\|degraded>` | Providers |
| `model list` · `model set-status <modelKey> <status>` | Models with status, tier and active prices |
| `model set-schema-mode <modelKey> <full\|basic>` | `basic` sends the JSON schema without value constraints (output is still fully validated) |
| `model import-openrouter <modelKey>… [--tier <tier>] [--apply]` | Plan (dry run) or import LLMs from OpenRouter's public catalog; new models start disabled |
| `model import-openrouter-images\|-videos\|-tts <modelKey>… [--tier] [--apply]` | Same for image, video and TTS models, with their limits and prices |
| `price add <modelKey> <metric> <usdPerUnit> --source <s> --url <url>` | Append a price row (rows are never edited) |
| `route list` · `route set <task> <modelKey> [--provider <key>]` | Routed model per task (`script_generation`, `storyboard_generation`, `image_generation`, `video_generation`) |
| `circuit list\|open\|close <providerKey>` | Provider circuit breakers |
| `invocations mark-abandoned` | Marks calls stuck in `started` past every deadline as `outcome_unknown` (never re-sent) |

Paid smoke tests make **real, paid calls**. Each needs `ACF_PAID_SMOKE=1`, an enabled model with a
known price, `--project <slug>` and `--max-cost-usd <usd>`, and refuses if the worst case exceeds
the cap. They print reported vs estimated cost:

| Command | Calls |
|---|---|
| `smoke <modelKey>` | One tiny LLM call |
| `smoke-image <modelKey> [--count 1-10] [--resolution 2K] [--out dir]` | Fixed 9:16 image prompt; saves images |
| `smoke-video <modelKey> [--frame img] [--duration s] [--resolution 720p] [--count] [--out dir]` | Submit, poll (20 min limit), download, FFprobe; saves clips |
| `smoke-tts <modelKey> --voice <id> [--text "…"] [--count] [--out dir]` | ZDR required; saves MP3/WAV |

Before enabling a model for real work: review its terms, run the smoke test, benchmark it
(`docs/AI_PROVIDER_STRATEGY.md` §7), then `model set-status … enabled` and `route set`.

Behind an HTTPS proxy, Node's `fetch` (catalog import, smoke tests) needs `NODE_USE_ENV_PROXY=1`
(and `NODE_EXTRA_CA_CERTS` for a custom CA).

## 9. Infrastructure

| Command | What it does |
|---|---|
| `pnpm infra:up` | Start PostgreSQL, Redis and SeaweedFS and wait until healthy |
| `pnpm infra:down` | Stop the containers, keep the data |
| `pnpm infra:reset` | Stop the containers and **delete** the data volumes |
| `pnpm infra:logs` | Follow the container logs |

## 10. Troubleshooting

- **Invalid environment configuration**: compare `.env` with `.env.example`; the message names each
  invalid variable.
- **Readiness `503 unreachable`**: run `pnpm infra:up`, check `docker compose ps`.
- **Port in use**: change `POSTGRES_PORT`, `REDIS_PORT` or `API_PORT` in `.env` and update
  `DATABASE_URL`/`REDIS_URL` to match.
- **`Cannot find module '@acf/...'`**: run `pnpm build:packages`.
- **`permission denied` / password failed for `acf_app`**: run `pnpm db:setup`; check the four
  database URLs against `.env.example`.
- **Generation answers "No usable model for this task"**: no enabled route; run `pnpm db:seed` or
  set a route.
- **Jobs stay queued**: the worker is not running (`pnpm dev:worker`).
- **Clip or voice-over fails with "FFmpeg or FFprobe is not installed"**: see Windows in §1 (or
  install with your package manager), then Resume. Nothing was sent to the provider.
- **Render or `pnpm media:selftest` fails with "unsafe path for a filter graph"**: FFmpeg filter
  graphs cannot quote paths, so the temp directory may hold only letters, digits, `/ \ _ . -` and a
  drive (`C:`). Windows temp paths such as `C:\Users\ADMIN\AppData\Local\Temp` work. If your
  Windows user name has spaces or accents, point the temp directory elsewhere for the worker, e.g.
  `mkdir C:\acf-tmp` and set `TEMP=C:\acf-tmp` and `TMP=C:\acf-tmp` before `pnpm dev:worker`.
