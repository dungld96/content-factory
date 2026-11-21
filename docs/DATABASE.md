# Database

PostgreSQL with Prisma. The authoritative schema is `packages/database/prisma/schema.prisma` plus
the migrations in `packages/database/prisma/migrations/`; each migration ends with hand-written
SQL (CHECKs, functions, triggers) that Prisma does not model. Design detail per area is in the
milestone packages in `docs/design/` and ADR-0010, ADR-0011, ADR-0012.

## 1. Principles

- PostgreSQL is the source of truth for production state; binaries live in object storage.
- **Rules are enforced by the database**, not only by services: composite foreign keys on
  `(project_id, id)` keep every row in its project; triggers make approved and historical rows
  immutable. Violations raise custom SQLSTATEs (`AC001`–`AC017`, catalogue in ADR-0011 and
  `packages/database/src/errors.ts`), mapped to API errors (`docs/API_SPEC.md` §11).
- **Archive, never delete** projects, channels, characters, environments, assets, content
  masters and items, voice profiles (`AC006`).
- **Versions, not overwrites**: edits create new immutable versions; approved masters and
  reference assets never change.
- **Append-only history**: prices, usage, job events, selection events, budget and circuit
  events (`AC011`).
- UUIDv7 IDs; UTC timestamps; money as exact decimals, never floats.

## 2. Tables by area

### Identity and workspace

| Table | Purpose |
|---|---|
| `users`, `sessions` | Accounts; sessions store only `SHA-256(session ID)` (ADR-0009) |
| `projects`, `project_members` | Projects and roles (`owner`, `editor`, `viewer`). Every project keeps at least one owner (`AC007`) |
| `channels` | Publishing channel per project (`tiktok`, `instagram_reels`, `youtube_shorts`, `other`) |

### Brand assets

| Table | Purpose |
|---|---|
| `characters`, `character_versions`, `character_version_assets` | Characters and their versions with linked reference assets |
| `environments`, `environment_versions`, `environment_version_assets` | Same for environments |
| `assets` | Every file: type (`reference`, `image`, `video`, `audio`, `subtitle`, `render`), source (`upload`, `import`, `generated`, `derived`), storage key, MIME, size, checksum, dimensions, duration, review status, links to its generating job and scene |
| `asset_inputs` | Append-only lineage: inputs of a generated asset (role `character`, `environment`, `scene_reference`, `keyframe`, `clip`, `voiceover`, `music`) |
| `asset_collections`, `asset_collection_items` | Named groups of Library assets per project (archived, never deleted) and their members (same project through composite FKs). Organisational only: never read by production |

Rules: approved versions and their links are immutable (`AC001`, `AC002`); the master pointer
moves only forward to an approved version (`AC003`, `AC004`); asset identity and lineage never
change, nor the metadata keys the platform writes (`acf_system_metadata_keys()`: `purpose`, reuse
hashes, probe data; `AC005`); an asset in use cannot be archived (`AC008`) and an archived asset blocks
approval (`AC010`).

### Content

| Table | Purpose |
|---|---|
| `content_masters` | The shared idea: title, brief, `brief_revision` (grows with each brief change), language |
| `content_items` | A variant of a master: format, duration, aspect ratio, language, its own brief copy, `master_brief_revision`, channel **or** `target_platform`, status, voice profile, and the gate pointers `approved_script_version_id`, `approved_storyboard_version_id`, `approved_render_id`. Never moves to another master (`AC014`) |
| `script_versions` | Immutable scripts (with content plan); one review (`pending_review` → `approved`/`rejected`); source `generated` (job) or `edited` (base version, author) |
| `storyboard_versions`, `storyboard_scenes`, `storyboard_scene_assets` | Immutable storyboards of a script version, their scenes and scene reference assets |

Rules: versions change only by their one review (`AC012`); gate pointers reference approved
versions of the same item, and the storyboard's script must be the approved script (`AC013`).

### Scene media and renders

| Table | Purpose |
|---|---|
| `scene_keyframes`, `scene_keyframe_events` | Chosen image per scene (gate 3) and its history (`selected`, `reused`) |
| `scene_clips`, `scene_clip_events` | Chosen clip per scene (gate 4) and its history (`selected`, `reused`, `cleared`) |
| `scene_voiceovers`, `scene_voiceover_events` | Chosen voice-over per scene (generated or uploaded) and its history |
| `voice_profiles` | Project voices: model, provider voice, language, speed (0.5–2), instructions |
| `renders` | One render: frozen manifest and settings, execution key, outputs (video, subtitle, thumbnail assets, duration; set once), QC report, gate-5 review, export. Never deleted |

Rules: a selection is an approved, active asset of the scene's own content item, and the asset
cannot lose its approval or be archived while selected (`AC015`, `AC016`, `AC008`);
`approved_render_id` must point to an approved render (`AC017`).

### Jobs

| Table | Purpose |
|---|---|
| `production_runs` | One per generate request; `resumed_from_run_id` for a resume |
| `generation_jobs` | Job intent, written before enqueueing: kind (`script_generation`, `storyboard_generation`, `image_generation`, `video_generation`, `tts_generation`, `render`), status (`queued`, `running`, `succeeded`, `failed`, `canceled`), `active_key` (one active job per item or scene and kind), idempotency key, execution key, inputs, prompt template and resolved prompt snapshot, model, attempts, result, sanitized error. Video jobs also hold the submission intent (written **before** the paid submit) and the provider job (`provider_job_id` unique, status, poll schedule). Video and TTS jobs record the paid output as delivered, before validation (P3d: `delivered_at`, `staged_asset_id`, `staged_object_key`, `staged_sha256`, `staged_mime_type`; write-once, `AC011`); a finish job points at the failed job it completes (`recover_from_job_id`) |
| `job_events` | Append-only state transitions |

Rules: job and run identity are immutable, terminal jobs never change, a provider job ID once set
is frozen (`AC011`).

### AI registry and ledger

| Table | Purpose |
|---|---|
| `ai_providers` | Provider (`key`, kind `gateway`/`direct`/`mock`, status, terms and data-policy links) |
| `ai_models`, `ai_model_capabilities` | Models per provider: parameters, modalities, limits (`image_constraints`, `media_constraints`), `schema_mode` (`full`/`basic`), quality tier, status (new models start `disabled`), notes, benchmark score |
| `ai_model_prices` | Append-only prices: metric, `unit_price` (USD per unit, `NUMERIC(38,18)`), published value, `variant`, prompt-size tier, `effective_from`, source, URL |
| `ai_task_routes` | Routed model per generation task |
| `ai_invocations` | One row per provider call: inserted `started` before the call, updated once with outcome, latency, `reported_cost`, `estimated_cost`, `cost_status` (`reported`/`estimated`/`unknown`). No prompts or completions stored |
| `ai_usage_records` | Append-only usage per metric: quantity, unit price and cost (both null when unknown), price row used |

CHECKs: USD only; no negative amounts; usage cost = quantity × unit price, present exactly when
the price is known; `cost_status` matches the stored amounts.

### Budgets and circuits

| Table | Purpose |
|---|---|
| `project_budgets` | One per project: monthly, per-item and per-request limits (`DECIMAL(14,6)` USD), each `hard` or `soft`. Locked `FOR UPDATE` while a request reserves |
| `budget_events` | Append-only: `changed`, `override`, `blocked`, `settled`, `released` |
| `budget_reservations` | One per paid job, written with the job: amount (estimate, or USD 0.50 placeholder for unknown cost), status `open` → `settled`/`released`/`held` (`held` → `settled`/`released`), `settled_charge_usd` for a held charge an owner confirmed |
| `provider_circuits`, `provider_circuit_events` | Circuit per provider (`closed`, `open`, `half_open`), failure counts, retry time, trial job; append-only transitions |
| `ai_registry_events` | Append-only audit of registry changes: `source` (`api` with the operator, `cli` without), `action`, `target`, `before`, `after` |

## 3. Content status

`content_status` values: `draft`, `researching`, `planning`, `scripting`, `script_review`,
`storyboarding`, `storyboard_review`, `generating_assets`, `asset_review`, `rendering`,
`quality_review`, `approved`, `exported`, `failed`, `canceled`, `needs_input`. Transitions:
`docs/CONTENT_PIPELINE.md` §2. Archival is a separate `archived_at` column.

## 4. Asset lineage

Every generated asset can be traced to: its job (resolved prompt, model, provider, parameters),
its scene, its input assets (`asset_inputs`), the character and environment versions used, its
creation time and its review state.

## 5. Migrations

- Every schema change is a Prisma migration; never edit an applied one. Migrations are
  forward-only (no down-migrations).
- A migration that alters a guarded table must keep its trigger (use
  `CREATE OR REPLACE FUNCTION` when a frozen-column list changes).
  `packages/database/test/schema-objects.integration.test.ts` fails if a trigger or CHECK is
  missing or disabled, or if the database drifts from `schema.prisma`.
- A new enum value needs its own migration before it is used (PostgreSQL restriction).
- Seed only development data: `pnpm db:seed` is idempotent and refuses `NODE_ENV=production`.

## 6. Locking

Approvals lock the version, then the content item (ADR-0011 order). Budget reservations lock the
project budget; circuits lock their row. Ledger inserts take only `FOR KEY SHARE`. Concurrency
tests in `packages/database/test/` fail on any deadlock (`40P01`).

## 7. Indexes

Foreign keys used in list and filter queries are indexed; unique keys include
`(project_id, slug)` for named resources, `(character_id, version)`, `(environment_id, version)`,
`generation_jobs.idempotency_key` and `provider_job_id`. Lists page by `created_at DESC, id DESC`.

## 8. Database roles

| Role | Used by | Privileges |
|---|---|---|
| admin (compose `POSTGRES_USER`) | `pnpm db:setup`, integration-test setup (local/CI only) | Superuser: creates roles and databases |
| `acf_migrator` | `prisma migrate`, seed, test cleanup | Owns databases, tables, functions and triggers; not a superuser |
| `acf_app` | API and worker at runtime (`DATABASE_URL`) | `SELECT/INSERT/UPDATE/DELETE` only; cannot disable or drop triggers, truncate, set `session_replication_role`, or read `_prisma_migrations` |

Names and passwords come from `DATABASE_MIGRATION_URL` and `DATABASE_URL`. In production,
create the same roles and grants (`packages/database/src/admin/bootstrap.ts`); the admin URL is
never given to the application.
