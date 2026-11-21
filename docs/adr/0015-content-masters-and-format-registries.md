# ADR-0015: Content masters, variants and format/platform registries

- Status: Accepted (M3.5 review approved 2026-11-18; implemented in slice R0)
- Date: 2026-11-18
- Milestone: M3.5 / R0

## Context

After M3, one `content_items` row is one deliverable: a format, an optional channel, a duration,
an aspect ratio, a language, a brief, and its own scripts, storyboards and jobs. The product will
later publish one idea in several formats and on several platforms. Nothing could hold the shared
idea, and platforms were only a label on a channel. The review
(`docs/design/M3.5-multiformat-architecture-review.md`) proposed a minimal change; the owner
approved every recommendation.

## Decision

1. **Masters and variants (AD-1).** New table `content_masters` (title, brief, `brief_revision`,
   language). `content_items` stays — same table, IDs and `/content/:contentId` API — and is the
   **variant**: it gains `content_master_id` (required, same project, never changes: `AC014`),
   `target_platform` and `master_brief_revision`. Migration `m35_content_masters` backfills one
   master per existing item (1:1, UUIDv7 from the item's `created_at`).
2. **Brief copy-on-create (AD-2).** A variant copies the master brief when created and may edit
   it. The master's `brief_revision` grows with each brief change; a variant whose copied
   revision is lower reports `masterBriefStale` and can be resynced explicitly
   (`POST /content/:contentId/brief/resync`). M3 execution keys and approvals are unaffected.
   A revision counter replaced the review's hash (simpler; pure SQL backfill).
3. **Registries in code (AD-3/AD-4).** `packages/content-domain` holds `FORMAT_DEFINITIONS`
   (`short_video` only, M3 rules unchanged), `PLATFORM_PROFILES` (one per `channel_platform`
   value) and the format × platform compatibility matrix. A format chooses the pipeline; a
   platform only adds limits. Every platform fact carries its source URL, basis and check date;
   unverified limits are left unset and never enforced. Platform limits produce brief
   **warnings** only.
4. **Target platform (owner decision).** With a channel, the channel's platform applies and
   `target_platform` is stored as NULL (CHECK `content_items_platform_xor_channel`); an explicit
   platform must match the channel (`422 PLATFORM_CHANNEL_MISMATCH`). Without a channel,
   `target_platform` is the variant's own, optional platform. Storing it only then keeps it
   consistent when a channel's platform is edited.
5. **Locking.** Create variant: master `FOR KEY SHARE`, refuse if archived. Archive master:
   master `FOR UPDATE`, refuse while a variant is active (`409 MASTER_HAS_ACTIVE_VARIANTS`).
   Edit master: `FOR NO KEY UPDATE`. One row lock each; verified by lock-boundary tests.

## Consequences

- No M1–M3 endpoint, job, version or trigger changes behaviour; content responses gain
  `contentMasterId`, `targetPlatform`, `masterBriefRevision`, `masterBriefStale`.
  `POST /projects/:projectId/content` creates a master and its first variant.
- Direct-SQL inserts into `content_items` must supply a master (test fixtures updated).
- Adding a format later needs an enum value, a `FormatDefinition`, its pipeline stages and, for
  non-video formats, nullable duration/aspect columns plus `format_spec` (review §3.1, R2).
- Platform facts are dated; they must be re-verified on official pages before any publishing
  feature relies on them.

## Alternatives considered

- Rename `content_items` to `content_variants` and move every foreign key: cleaner names, but
  churn across all M1–M3 code, triggers and tests.
- Canonical master brief merged with per-variant overrides: one source of truth, but a master
  edit would silently invalidate every variant's approvals.
- Format and platform tables editable at runtime: more schema and admin surface before any
  operator needs it.
