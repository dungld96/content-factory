# Database Design

Use PostgreSQL with Prisma. The schema below describes the logical model; Claude Code should translate it into Prisma models and migrations, then validate relations and indexes.

## 0. Implemented schema (M1)

The authoritative physical schema is `packages/database/prisma/schema.prisma` plus the migrations in `packages/database/prisma/migrations/`. The M1 design (tables, composite foreign keys, CHECK constraints, triggers, lock protocol) is documented in `docs/design/M1-design-review-package.md` and ADR-0010 / ADR-0011.

Implemented in M1a (migration `init_m1`): `users`, `sessions`, `projects`, `project_members`, `channels`, `characters`, `character_versions`, `character_version_assets`, `environments`, `environment_versions`, `environment_version_assets`, `assets`, `content_items`. Content, production and delivery entities beyond `ContentItem` arrive in later milestones.

Key rules enforced by the database itself (not only by services):
- Project isolation through composite foreign keys on `(project_id, id)`.
- Archive instead of delete for projects, channels, characters, environments, assets and content items (`AC006`).
- Approved character/environment versions and their asset links are immutable (`AC001`, `AC002`); the master pointer only moves forward to an approved version (`AC003`, `AC004`).
- Asset file identity and lineage are immutable (`AC005`); an asset used by an approved version cannot be archived (`AC008`) and an archived asset blocks approval (`AC010`).
- Every project keeps at least one owner (`AC007`).

The full SQLSTATE catalogue is in ADR-0011 and `packages/database/src/errors.ts`.

## 0.1 Implemented schema (M2: AI registry and usage ledger)

Migration `m2_ai_registry` (design: `docs/design/M2-design-review-package.md` §6, ADR-0012) adds, without changing any M1 table:

| Table | Purpose |
|---|---|
| `ai_providers` | Provider registry (`key`, `kind` gateway/direct/mock, `status`, terms and data-policy links). |
| `ai_models` | Model registry per provider: `model_key`, `canonical_slug`, supported parameters, modalities, context/output limits, quality tier, `status` (new models start `disabled`), free-variant flag, rate-limit and data-policy notes, benchmark score. |
| `ai_model_capabilities` | Normalized `(model_id, capability)` pairs. |
| `ai_model_prices` | Append-only price rows: metric, `unit_price` (USD per unit, `NUMERIC(38,18)`), the published `source_value`, prompt-size tier (`min_prompt_tokens`), `effective_from`, source and URL. The active price is the latest row with `effective_from <= t`; no row means unknown cost. |
| `ai_invocations` | One row per provider call, inserted as `started` before the call and updated once with the outcome: status, normalized `error_code`, finish reason, latency, `reported_cost`, `estimated_cost`, `cost_status` (`reported`/`estimated`/`unknown`). `generation_job_id` gets its foreign key in M5. Prompts and completions are not stored. |
| `ai_usage_records` | Append-only per-metric usage of an invocation: quantity, unit price and cost (both null when unknown), the price row used, source. |

Money in these tables is exact decimal USD (`NUMERIC(38,18)`, ADR-0012); integer micros cannot hold per-token LLM costs. Enforced by the database:
- `AC011`: price and usage rows cannot be updated or deleted; an invocation is inserted as `started`, gets exactly one outcome, never changes identity columns and is never deleted.
- CHECKs: USD only; non-negative prices, quantities and costs; a usage cost equals quantity × unit price and exists exactly when the unit price is known; `completed_at` and `error_code` match the status; `cost_status` matches the stored amounts (unknown cost is never an amount).
- Composite foreign keys: an invocation's content item belongs to its project and its model to its provider; a usage record belongs to its invocation's project.
- Locking: the ledger takes part in no M1 lock order; invocation inserts take only `FOR KEY SHARE` on referenced rows and never wait on the owner-change protocol (verified in `packages/database/test/ai-ledger.integration.test.ts`).

## 0.2 Implemented schema (M3: script and storyboard pipeline)

Migration `m3_script_storyboard` (design: `docs/design/M3-design-review-package.md` §4, ADR-0013):

| Table | Purpose |
|---|---|
| `production_runs` | Minimal run per generate request (M3 Q7): status, requester. |
| `generation_jobs` | Job intent persisted before enqueueing: kind, status, `active_key` (one active job per content item and kind), idempotency key, execution key (sha256 of all inputs), input ids, previous content status, prompt template id and resolved prompt snapshot, model, attempts, result version, sanitized error. |
| `job_events` | Append-only state transitions with sanitized details. |
| `script_versions` | Immutable script versions (content plan included): version number, status (`pending_review` → `approved`/`rejected` once), source (`generated` with its job / `edited` with its base version and author), validated JSON. |
| `storyboard_versions`, `storyboard_scenes`, `storyboard_scene_assets` | Immutable storyboard versions of a script version, their scenes (CONTENT_PIPELINE stage 5 fields; character/environment versions and reference assets of the same project). |
| `ai_task_routes` | Model per generation task, set by the operator CLI (M3 Q4). |

`content_items` gains `approved_script_version_id` and `approved_storyboard_version_id` (gates 1 and 2, ADR-0005); `ai_invocations.generation_job_id` now has its composite foreign key.

Enforced by the database: `AC012` (versions, scenes and scene assets are immutable except one review; edits are new versions); `AC013` (pointers reference approved versions of the same item; the storyboard pointer's script is the approved script, so a stale storyboard cannot be approved); `AC011` (job events append-only; job and run identity immutable; terminal jobs never change); CHECKs for attempts, active key, completion, error and result consistency. Approvals lock the version, then the content item (ADR-0011 order); verified by `packages/database/test/artifact-concurrency.integration.test.ts` (0 × `40P01`).

## 0.3 Implemented schema (R0: content masters and variants)

Migration `m35_content_masters` (design: `docs/design/M3.5-multiformat-architecture-review.md` §3, ADR-0015). Additive only.

| Table / column | Purpose |
|---|---|
| `content_masters` | The shared idea of one or more variants: title, brief, `brief_revision` (grows with every brief change), default language; archived, never deleted. |
| `content_items.content_master_id` | Required; the master of this variant (composite FK, same project). Never changes (`AC014`). |
| `content_items.target_platform` | Platform of a variant **without** a channel; NULL when a channel is set (its platform applies; CHECK `content_items_platform_xor_channel`). |
| `content_items.master_brief_revision` | The master brief revision this variant's brief was copied from; lower than the master's means "master changed". |

Backfill: one master per pre-existing content item (title, brief, language, author, archive and timestamps copied; UUIDv7 from the item's `created_at`). Locking: creating a variant takes the master `FOR KEY SHARE`, archiving it `FOR UPDATE` (refused while a variant is active); verified by `packages/database/test/content-masters.integration.test.ts`.

## 0.4 Implemented schema (M4: images)

Migrations `m4_image_registry` and `m4_images` (design: `docs/design/M4-design-review-package.md` §4.4, §5, §6):

| Table / column | Purpose |
|---|---|
| `ai_price_metric` += `output_images`, `input_images`, `output_pixels`, `input_pixels`, `output_image_tokens`, `input_image_tokens` | Image prices: per image, per pixel (per-megapixel prices stored per pixel) or per image token. |
| `ai_model_prices.variant` | Resolution tier a price applies to (`2k`, …); `''` = any request. Part of the unique key. |
| `ai_models.image_constraints` | Image model limits from the provider's endpoint record: `maxImages`, `maxReferences`, `aspectRatios`, `resolutions`, `seed`. |
| `generation_job_kind` += `image_generation`; `generation_jobs.storyboard_scene_id` | Image jobs are scene-scoped: one active image job per scene (`active_key = {sceneId}:image_generation`); a succeeded image job links its results through `assets.generation_job_id`. |
| `assets.generation_job_id`, `assets.storyboard_scene_id`, `assets.reviewed_by_id`, `assets.reviewed_at` | Generated images link their job (required iff `source_type = generated`) and the scene they were made for; candidate review. Both links are immutable (`AC005`). |
| `asset_inputs` | Append-only lineage: the reference images sent with a generation (`character`, `environment`, `scene_reference`). |
| `scene_keyframes`, `scene_keyframe_events` | The selected image of each storyboard scene (gate 3 input) and its append-only selection history (`selected`/`reused`). |

Enforced by the database: `AC015` (a keyframe is an approved, active image of the scene's own content item; never deleted; the asset cannot lose its approval while it is a keyframe), `AC008` extended (a keyframe asset cannot be archived), CHECKs for the job/scene and asset/job pairing. The keyframe trigger reads the asset `FOR SHARE`, so it serializes with an asset update that would archive it or revoke its approval.

## 0.5 Implemented schema (M5: video and audio)

Migrations `m5_media_registry` (M5b), `m5_job_kinds` (enum values only: PostgreSQL cannot use a
new enum value in the transaction that adds it) and `m5_media` (design:
`docs/design/M5-design-review-package.md` §5–§7, ADR-0017):

| Table / column | Purpose |
|---|---|
| `ai_price_metric` += `output_video_seconds`, `input_characters`, `output_video_tokens` | Video prices per billed second (variant `720p-silent`, `720p`, `audio`, …: most specific first), TTS prices per input character, video tokens (recorded only). |
| `ai_models.media_constraints` | Video limits (`durations`, `resolutions`, `aspectRatios`, `frameImages`, `audio`, `seed`, optional operator-set `minBilledSeconds`) or TTS limits (`voices`, `mp3`), tagged by `kind`. |
| `generation_job_kind` += `video_generation`, `tts_generation` | Scene-scoped like images: one active job per scene and kind (`active_key = {sceneId}:{kind}`). |
| `generation_jobs.provider_key`, `invocation_id`, `submitted_at` | The submission intent, recorded **before** the paid submit (decision V3). Cleared only when the provider refused the submit. |
| `generation_jobs.provider_job_id` (unique), `provider_status`, `provider_expires_at`, `poll_count`, `last_polled_at`, `next_poll_at` | The provider's async job and how it is being followed. Once `provider_job_id` is set, it and the intent are frozen (`AC011`); `poll_count` never decreases. Video jobs only (CHECK). |
| `asset_inputs.role` += `keyframe` | A clip's input: the keyframe it starts from. |
| `scene_clips`, `scene_clip_events` | The selected clip of each scene (gate 4) and its append-only history (`selected`, `reused`, `cleared`). A selection may be deleted (cleared when the scene's keyframe changes). |
| `scene_voiceovers`, `scene_voiceover_events` | The selected voice-over of each scene: a generated audio file of the scene's content item, or an imported voice-over upload (no content item). Same history. |
| `voice_profiles` | Project voices for TTS: model, provider voice, language tag, speed (0.5–2), instructions; archived, never deleted. |
| `content_items.voice_profile_id` | The voice profile used for this item's voice-overs (composite FK, same project). |

Enforced by the database: `AC016` (a selected clip/voice-over is an approved, active video/audio of
the scene's content item, or for voice-overs an imported upload; the selection stays on its scene;
the asset cannot lose its approval while selected), `AC008` extended (a selected clip or voice-over
cannot be archived). The selection triggers read the asset `FOR SHARE`. Verified by
`packages/database/test/media.integration.test.ts`.

## 1. Entity groups

### Identity and workspace
- `User`
- `Project`
- `Channel`

### Brand and reusable assets
- `Character`
- `CharacterVersion`
- `Environment`
- `EnvironmentVersion`
- `Asset`

### Content
- `ContentItem`
- `ContentBrief`
- `ResearchReport`
- `ScriptVersion` (implemented as `script_versions`, M3)
- `StoryboardVersion` (implemented, M3)
- `Scene` (implemented as `storyboard_scenes`, M3)

### Production
- `ProductionRun` (implemented, M3)
- `GenerationJob` (implemented, M3)
- `JobEvent` (implemented, M3)
- `Provider` (implemented as `ai_providers`, M2)
- `Model` (implemented as `ai_models`, `ai_model_capabilities`, `ai_model_prices`, M2)
- `ProviderCredential` (store encrypted secret reference, never plaintext)
- `UsageRecord` (implemented as `ai_invocations` + `ai_usage_records`, M2)
- `Budget`

### Delivery
- `Render`
- `Approval`
- `PublishingPackage`
- `Publication` (future)
- `AnalyticsSnapshot` (future)

## 2. Core relations

- One `Project` has many `Channel`, `Character`, `Environment`, and `ContentItem`.
- One `Character` has many immutable `CharacterVersion` records.
- One `Environment` has many immutable `EnvironmentVersion` records.
- One `ContentItem` has many script/storyboard versions and production runs.
- One `StoryboardVersion` has many `Scene`.
- One `Scene` can reference character/environment versions and multiple input/output assets.
- One `ProductionRun` has many `GenerationJob`.
- One `GenerationJob` has many `JobEvent` and may create one or more `Asset`.
- One `GenerationJob` has zero or more `UsageRecord`.
- One `ContentItem` can have multiple `Render` outputs.
- Approval records identify who approved what version and when.

## 3. Important fields

### Project
- `id` UUID
- `name`
- `slug`
- `description`
- `defaultLanguage`
- `timezone`
- `status`
- `createdAt`, `updatedAt`

### ContentMaster (R0)
- `id`, `projectId`, `title`, `brief`, `briefRevision`, `language`, `createdById`, `archivedAt`, timestamps

### ContentItem (a variant of a ContentMaster since R0)
- `id`
- `projectId`
- `contentMasterId`, `targetPlatform` nullable, `masterBriefRevision`
- `channelId` nullable
- `title`
- `status`
- `format` (e.g. short_video)
- `targetDurationSeconds`
- `aspectRatio`
- `language`
- `briefJson`
- `createdById`
- timestamps

### CharacterVersion
- `id`
- `characterId`
- `version`
- `description`
- `identityRulesJson`
- `referenceAssetIds` (prefer relation table rather than JSON for queryable links)
- `approvedAt`
- `createdAt`

### EnvironmentVersion
- `id`
- `environmentId`
- `version`
- `description`
- `visualRulesJson`
- reference assets
- approval state

### Asset
- `id`
- `projectId`
- `contentItemId` nullable
- `sceneId` nullable
- `assetType` (image, video, audio, subtitle, render, reference)
- `storageKey`
- `mimeType`
- `sizeBytes`
- `durationMs` nullable
- `width`, `height` nullable
- `checksum`
- `sourceAssetId` nullable
- `providerId`, `modelId` nullable
- `generationJobId` nullable
- `promptSnapshot` nullable
- `metadataJson`
- `approvalStatus`
- timestamps

### GenerationJob
- `id`
- `productionRunId`
- `contentItemId`
- `sceneId` nullable
- `capability`
- `providerId`
- `modelId`
- `providerJobId` nullable
- `status`
- `idempotencyKey` unique
- `requestJson` (redact secrets)
- `responseMetadataJson`
- `estimatedCostMicros` nullable
- `actualCostMicros` nullable
- `currency`
- `attempt`
- `startedAt`, `completedAt`
- `errorCode`, `errorMessage` (sanitized)

### UsageRecord

Implemented in M2 as `ai_invocations` (per call) and `ai_usage_records` (per metric); see §0.1. The sketch below is the original logical model.

- `id`
- `generationJobId`
- `metricType` (input_tokens, output_tokens, image_count, video_seconds, audio_characters, provider_credits, etc.)
- `quantity`
- `unit`
- `unitPriceMicros` nullable
- `costMicros` nullable
- `isEstimated`
- `source` (provider_reported, calculated, manual)
- `recordedAt`

### Budget
- `id`
- `projectId`
- `period` (per_content, daily, monthly)
- `limitMicros`
- `currency`
- `enforcementMode` (hard, soft)
- `active`

## 4. Enums

Suggested enums:
- `ProjectStatus`: not an enum; projects are archived via `archivedAt` (M1).
- `ContentStatus`: the canonical list is `docs/CONTENT_PIPELINE.md` §1 (decision U1): draft, researching, planning, scripting, script_review, storyboarding, storyboard_review, generating_assets, asset_review, rendering, quality_review, approved, exported, failed, canceled, needs_input. Archival is a separate `archivedAt` column, not a status.
- `JobStatus`: queued, running, waiting_provider, succeeded, failed, canceled, needs_review
- `AssetType`: reference, image, video, audio, subtitle, render
- `ApprovalStatus`: pending, approved, rejected, changes_requested
- `Capability`: llm, image_generation, image_edit, video_generation, tts, transcription, vision_evaluation
- `ProviderStatus`: enabled, disabled, degraded

## 5. Indexes and constraints

- Index all foreign keys used in list/filter queries.
- Unique `(projectId, slug)` for project/channel/character names where appropriate.
- Unique `(characterId, version)` and `(environmentId, version)`.
- Unique `GenerationJob.idempotencyKey`.
- Index `(contentItemId, createdAt)` for production history.
- Index `(productionRunId, status)` for job monitoring.
- Index `(providerId, modelId, recordedAt)` for usage reporting.
- Store monetary values as integer micros or Decimal; do not use floating point for money. AI costs use exact decimal USD, `NUMERIC(38,18)` (ADR-0012).
- Use soft deletion only where audit/history requirements justify it.
- Prefer normalized relation tables for assets and version references.

## 6. Asset lineage

Every generated asset must be traceable to:
- Original prompt and resolved prompt.
- Provider and model.
- Generation job.
- Input/reference assets.
- Character/environment versions.
- Generation parameters.
- Creation timestamp.
- Approval state.

Do not overwrite reference/master assets. Create new versions or derived assets.

## 7. Migration policy

- Every schema change uses a Prisma migration.
- Never edit an already-applied migration.
- Seed only development/demo data. `pnpm db:seed` (`apps/api/src/cli/seed.ts`) creates the demo
  workspace as the migrator role, is idempotent, and refuses `NODE_ENV=production`.
- Include indexes and constraints in migrations.
- Test migrations against an empty database and a previous-version database.
- CHECK constraints, functions and triggers live in migration SQL. A migration that alters a guarded table must keep its trigger (use `CREATE OR REPLACE FUNCTION` when a frozen-column list changes). `packages/database/test/schema-objects.integration.test.ts` fails if a trigger or CHECK goes missing or is disabled, or if the database drifts from `schema.prisma`.

## 8. Database roles

| Role | Used by | Privileges |
|---|---|---|
| admin (compose `POSTGRES_USER`) | `pnpm db:setup`, integration-test setup (local/CI only) | Superuser: creates roles and databases |
| `acf_migrator` | `prisma migrate`, seed, test cleanup | Owns the databases, tables, functions and triggers; not a superuser |
| `acf_app` | The API at runtime (`DATABASE_URL`) | `SELECT/INSERT/UPDATE/DELETE` only; cannot disable/drop triggers, truncate, set `session_replication_role`, or read `_prisma_migrations` |

Role names and passwords come from `DATABASE_MIGRATION_URL` and `DATABASE_URL`. In production, provision the same two roles and grants (see `packages/database/src/admin/bootstrap.ts`) with your platform's tooling; the admin URL is never configured for the application.
