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
- `ScriptVersion`
- `StoryboardVersion`
- `Scene`

### Production
- `ProductionRun`
- `GenerationJob`
- `JobEvent`
- `Provider`
- `Model`
- `ProviderCredential` (store encrypted secret reference, never plaintext)
- `UsageRecord`
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

### ContentItem
- `id`
- `projectId`
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
- Store monetary values as integer micros or Decimal; do not use floating point for money.
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
