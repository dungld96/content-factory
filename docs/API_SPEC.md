# REST API Specification

Base path: `/api/v1`  
Format: JSON  
Authentication: server-side sessions in an HttpOnly cookie (ADR-0009, §0.1). Every endpoint except health, login and (outside production) the OpenAPI document requires a session.

Use DTO validation (Zod or class-validator) and publish OpenAPI documentation.

## 0. Health (implemented in M0)

Health endpoints are unauthenticated and are never rate limited by business rules.

### `GET /health`
Liveness. Returns `200` while the process is running. It never touches dependencies.

```json
{ "status": "ok", "service": "acf-api", "version": "0.0.0", "uptimeSeconds": 12, "timestamp": "2026-11-17T04:02:41.171Z" }
```

### `GET /health/ready`
Readiness. Checks PostgreSQL (`SELECT 1`) and Redis (`PING`). Each check has a timeout
(`HEALTH_CHECK_TIMEOUT_MS`, default 2000 ms). Returns `200` when every check is `ok`, otherwise
`503`. Failure reasons are limited to `unreachable` or `timeout`; driver messages are never
returned. The response has `Cache-Control: no-store`.

```json
{
  "status": "error",
  "timestamp": "2026-11-17T04:02:50.378Z",
  "checks": {
    "database": { "status": "ok", "latencyMs": 2 },
    "redis": { "status": "error", "latencyMs": 41, "error": "unreachable" }
  }
}
```

Schemas: `packages/contracts/src/health.ts`.

### Correlation IDs
Every response carries `x-correlation-id`. A caller-supplied value is echoed only if it matches
`[A-Za-z0-9._-]{8,128}`; otherwise the server generates a UUID. The same ID appears in server
logs and in error bodies (§10).

## 0.1 Authentication (implemented in M1b)

Design: ADR-0009 and `docs/design/M1-design-review-package.md` §5. The browser talks only to
the Next.js origin, which rewrites `/api/v1/*` to the API.

- **Session cookie**: `acf_sid` locally, `__Host-acf_sid` when `SESSION_COOKIE_SECURE=true`
  (required in production): `HttpOnly; SameSite=Lax; Path=/`, no `Domain`, rolling 24 h idle
  expiry, 7 d absolute expiry. The server stores only `SHA-256(session ID)`.
- **Origin check**: every `POST`/`PUT`/`PATCH`/`DELETE` must send an `Origin` listed in
  `WEB_ORIGINS`, or, without `Origin`, `Sec-Fetch-Site: same-origin`. Otherwise
  `403 ORIGIN_REJECTED`. This includes login.
- **CSRF**: every state-changing request from a signed-in user sends `x-csrf-token`. The token
  comes from the login response or `GET /auth/csrf`, is bound to the session, and stops working
  after logout or re-login. Missing or invalid: `403 CSRF_INVALID`.
- **Check order**: Origin (`403`) → session (`401 UNAUTHORIZED`) → CSRF (`403`) → request
  validation (`400`).
- Roles are read from the database on every request; a disabled account loses its sessions
  immediately.

### `POST /auth/login`
Public, throttled per client IP (`LOGIN_RATE_LIMIT_PER_MINUTE`, default 10; then
`429 RATE_LIMITED`).

```json
{ "email": "owner@example.com", "password": "…" }
```

`200` sets the session cookie and returns:

```json
{ "user": { "id": "uuid", "email": "owner@example.com", "displayName": "Owner" }, "csrfToken": "…" }
```

Unknown email, wrong password and disabled account all return the same
`401 INVALID_CREDENTIALS`, with no cookie. If the API is configured for Secure cookies but the
request did not arrive over HTTPS through the trusted proxy, login fails closed with
`500 SESSION_COOKIE_NOT_SET`.

### `POST /auth/logout`
Revokes the session immediately and clears the cookies. `204`.

### `GET /auth/me`
```json
{
  "user": { "id": "uuid", "email": "owner@example.com", "displayName": "Owner" },
  "memberships": [{ "projectId": "uuid", "projectSlug": "ngan-khanh", "projectName": "Ngân Khánh", "role": "owner" }]
}
```

### `GET /auth/csrf`
`{ "csrfToken": "…" }` for the current session.

Accounts are created only with the CLI (`pnpm user:create`); there is no sign-up endpoint
(decision D6). Schemas: `packages/contracts/src/auth.ts`.

## 1. Projects

Implemented in M1c. Schemas: `packages/contracts/src/projects.ts`.

**Access rules (all workspace endpoints):** roles are `owner` > `editor` > `viewer` per project
and are checked in services on every request. A caller who is not a member of the project gets
`404 NOT_FOUND` (indistinguishable from a missing project; decision D7). A member whose role is
too low gets `403 FORBIDDEN`. Any change under an archived project returns `409 ARCHIVED`; reads
still work. Single-resource responses carry an `ETag`; `PATCH` honours `If-Match` (§11).

| Endpoint | Minimum role |
|---|---|
| `POST /projects` | any signed-in user (becomes owner) |
| `GET /projects` | lists the caller's memberships only |
| `GET /projects/:projectId`, `GET …/members`, `GET …/channels`, `GET …/content`, `GET /channels/:id`, `GET /content/:id` | viewer |
| channel and content create / update / archive | editor |
| `PATCH /projects/:projectId`, `POST /projects/:projectId/archive`, member add / change / remove | owner |

### `POST /projects`
Create a project. `slug` is globally unique (`409 SLUG_TAKEN`). `defaultLanguage` is a BCP 47
tag (canonicalized, e.g. `en-us` → `en-US`); `timezone` is an IANA zone. Returns `201` with the
project, including the caller's `role`.

Request:
```json
{
  "name": "Ngân Khánh Content",
  "slug": "ngan-khanh-content",
  "defaultLanguage": "vi",
  "timezone": "Asia/Ho_Chi_Minh"
}
```

### `GET /projects`
The caller's projects, newest first, paginated. Archived projects are hidden unless
`?includeArchived=true`.

### `GET /projects/:projectId`
Get project details.

### `PATCH /projects/:projectId`
Update `name`, `slug`, `description`, `defaultLanguage`, `timezone` (owner).

### `POST /projects/:projectId/archive`
Archive the project (owner). It becomes read-only; there is no unarchive in M1 (decision U7).

### Members
- `GET /projects/:projectId/members` → `{ "data": [{ "userId", "email", "displayName", "role", … }] }`.
- `POST /projects/:projectId/members` with `{ "email", "role" }` adds an existing active user
  (`404 USER_NOT_FOUND`, `409 ALREADY_MEMBER`).
- `PATCH /projects/:projectId/members/:userId` with `{ "role" }`; `DELETE` removes the member.
- A project always keeps at least one owner: demoting or removing the last owner returns
  `409 LAST_OWNER`. Concurrent owner changes are serialized on the project row (ADR-0011).

### Channels
- `POST /projects/:projectId/channels` with `{ "name", "slug", "platform", "handle"?, "description"? }`;
  `platform` is `tiktok`, `instagram_reels`, `youtube_shorts` or `other`; `slug` is unique per
  project (`409 SLUG_TAKEN`).
- `GET /projects/:projectId/channels` (paginated, `includeArchived`), `GET /channels/:channelId`,
  `PATCH /channels/:channelId`, `POST /channels/:channelId/archive`.
- Sending `""` for an optional text field clears it.

## 2. Characters and environments

Implemented in M1d (ADR-0010; design package §7). Characters and environments have the same
endpoints; replace `characters`/`character-versions`/`characterId` with
`environments`/`environment-versions`/`environmentId`. Schemas: `packages/contracts/src/brand.ts`.
Reads need viewer; everything else needs editor. Changes under an archived character/environment
(or project) return `409 ARCHIVED`.

| Endpoint | Notes |
|---|---|
| `POST /projects/:projectId/characters` | `{ name, slug, description? }`; slug unique per project |
| `GET /projects/:projectId/characters` | paginated; each item includes `master: { id, version, approvedAt } \| null` |
| `GET /characters/:characterId`, `PATCH`, `POST …/archive` | name/slug/description only; the master is never client-writable |
| `POST /characters/:characterId/versions` | new **draft**: `{ description, rules?, primaryAssetId?, assets? }`, or `{ basedOnVersionId }` to copy an older version (fields given override the copy) |
| `GET /characters/:characterId/versions` | paginated, newest first |
| `GET /character-versions/:versionId` | includes `assets: [{ assetId, sortOrder, note }]` |
| `PATCH /character-versions/:versionId` | drafts only (`409 VERSION_IMMUTABLE`); `If-Match` |
| `PUT /character-versions/:versionId/assets` | replaces a draft's links; changes the version's ETag; `If-Match` |
| `POST /character-versions/:versionId/approve` | `If-Match` (the ETag the reviewer saw) |

`rules` is the character's identity rules or the environment's visual rules (a JSON object, at
most 50 KB).

**Approval.** A draft becomes `approved` and the character's master in one transaction. The
master is always the highest-numbered approved version (decision D1). Errors:
`409 ALREADY_APPROVED` (with the version in `error.current`), `409 STALE_DRAFT` (the draft is
numbered below the master: create a new draft `basedOnVersionId` it instead), `409 ASSET_ARCHIVED`,
`412 PRECONDITION_FAILED`. Approved versions and their links never change. Rollback is
append-only: base a new draft on the old version and approve it.

Referenced assets must belong to the same project (`422 REFERENCE_NOT_FOUND`) and be active when
first referenced (`409 ASSET_ARCHIVED`). An asset archived later can stay on a draft, but that
draft cannot be approved (decision U4).

## 3. Content items

### `POST /projects/:projectId/content`
Create a content item.

Request:
```json
{
  "title": "5 useful desk gadgets",
  "format": "short_video",
  "language": "vi",
  "targetDurationSeconds": 30,
  "aspectRatio": "9:16",
  "brief": {
    "topic": "Useful technology products for office workers",
    "audience": "Vietnamese office workers",
    "objective": "education_and_affiliate",
    "tone": "modern, friendly",
    "callToAction": "Follow for more useful tech"
  }
}
```

Implemented in M1c (schemas: `packages/contracts/src/content.ts`). The brief accepts `topic`
(required), `audience`, `objective`, `tone`, `callToAction`, `notes` and up to 20 `sourceUrls`
(http/https); unknown keys are rejected. `channelId` (optional) must be an active channel of the
same project (`422 REFERENCE_NOT_FOUND`, `409 ARCHIVED`). `status` is set by the server: always
`draft` in M1; pipeline transitions arrive in M3.

### `GET /projects/:projectId/content`
List content items, newest first, paginated. Filters: `channelId`, `status`, `includeArchived`.

### `GET /content/:contentId`
Get item details and current production status.

### `POST /content/:contentId/archive`
Archive the content item (editor).

### `PATCH /content/:contentId`
Update `title`, `channelId` (or `null`), `targetDurationSeconds`, `aspectRatio`, `language`,
`brief` (editor). `format` and `status` are not writable. From M3, changes that invalidate
generated outputs must create a new content revision or mark downstream outputs stale.
R0: `targetPlatform` is also writable (see below).

### Content masters and variants (implemented in R0)

Design: `docs/design/M3.5-multiformat-architecture-review.md` §5, ADR-0015. Schemas:
`packages/contracts/src/content-masters.ts`. A content item is one **variant** of a **content
master** (the shared brief). Every M1–M3 `/content/:contentId` endpoint is unchanged.

- `POST /projects/:projectId/content` (same body) creates the master **and** this item as its
  first variant. Optional `targetPlatform` (`tiktok`, `instagram_reels`, `youtube_shorts`,
  `other`): with a channel it must equal the channel's platform (`422 PLATFORM_CHANNEL_MISMATCH`);
  a format the platform does not accept is `422 FORMAT_PLATFORM_INCOMPATIBLE`.
- Content item responses gain `contentMasterId`, `targetPlatform` (effective: the channel's
  platform when a channel is set), `masterBriefRevision` and `masterBriefStale`.
- Brief validation adds advisory platform warnings (verified platform limits only).

| Endpoint | Viewer | Editor/Owner | Notes |
|---|:-:|:-:|---|
| `POST /projects/:projectId/content-masters` | 403 | 201 | `{ title, brief, language }`; no variant |
| `GET /projects/:projectId/content-masters` | ✓ | ✓ | Paginated, newest first; `activeVariantCount`; `includeArchived` |
| `GET /content-masters/:masterId` | ✓ | ✓ | With all variants, newest first |
| `PATCH /content-masters/:masterId` | 403 | ✓ | `title`, `brief`, `language`; `If-Match`; a brief change increments `briefRevision` and marks variants stale |
| `POST /content-masters/:masterId/variants` | 403 | 201 | `{ format, targetDurationSeconds, aspectRatio, title?, language?, channelId?, targetPlatform? }`; copies the master brief; `409 ARCHIVED` for an archived master |
| `POST /content/:contentId/brief/resync` | 403 | ✓ | Copies the master's current brief into the item; `If-Match` |
| `POST /content-masters/:masterId/archive` | 403 | ✓ | `409 MASTER_HAS_ACTIVE_VARIANTS` until every variant is archived |

## 4. Production pipeline

### `POST /content/:contentId/production-runs`
Start a production run.

Request:
```json
{
  "stages": ["research", "script", "storyboard"],
  "options": {
    "qualityTier": "balanced",
    "maxBudgetMicros": 5000000
  },
  "idempotencyKey": "client-generated-unique-key"
}
```

Response:
```json
{
  "productionRunId": "uuid",
  "status": "queued"
}
```

### `GET /production-runs/:runId`
Return overall run status, stage status, progress, and summary.

### `POST /production-runs/:runId/cancel`
Cancel pending work where cancellation is supported.

### `POST /production-runs/:runId/resume`
Resume eligible failed/waiting stages.

## 5. Script and storyboard

### Implemented in M3

Design: `docs/design/M3-design-review-package.md` §6–§10. Viewers read; generating, editing,
approving, rejecting and canceling need editor (owner included); non-members get 404.

| Endpoint | Behaviour |
|---|---|
| `POST /content/:contentId/brief/validate` | Deterministic brief check (no LLM): `errors` (block generation), `warnings`, claim `flags` |
| `POST /content/:contentId/scripts/generate` | `202 { productionRunId, job, reused }`. Body `{ modelKey?, regenerate? }`, optional `Idempotency-Key` header. Identical inputs reuse the earlier result (`reused: true`, no new cost) unless `regenerate` |
| `GET /content/:contentId/scripts`, `GET /scripts/:id` | Versions newest first; `content` is the schema-validated script with the content plan; `isApproved` marks gate 1 |
| `PATCH /scripts/:id` | Body `{ content }` (full script): **new** version based on `:id` (201); the original never changes |
| `POST /scripts/:id/approve`, `POST /scripts/:id/reject` | One-time review (`{ note? }` on reject). Approval moves gate 1 and clears gate 2 (older storyboards become stale) |
| `POST /scripts/:id/storyboards/generate` | `202`, only from the approved script |
| `GET /content/:contentId/storyboards`, `GET /storyboards/:id` | Versions with `stale`, `isApproved`; detail includes scenes |
| `PATCH /scenes/:sceneId` | Partial scene: **new** storyboard version with that scene changed (201); numbering and total duration (target ± max(1 s, 5 %)) re-validated |
| `POST /storyboards/:id/approve`, `/reject` | One-time review; approval sets gate 2; a stale storyboard is refused |
| `GET /production-runs/:runId`, `POST /production-runs/:runId/cancel` | Run with jobs and cost; cancel stops queued work (a running call finishes and its result is discarded) |
| `GET /generation-jobs/:jobId` | Status, attempts, events, sanitized error, cost (`reportedUsd`, `estimatedUsd`, `unknownCalls`) |

### Original sketch

- `GET /content/:contentId/scripts`
- `POST /content/:contentId/scripts/generate`
- `PATCH /scripts/:scriptVersionId`
- `POST /scripts/:scriptVersionId/approve`
- `POST /scripts/:scriptVersionId/reject`
- `POST /scripts/:scriptVersionId/storyboards/generate`
- `GET /storyboards/:storyboardVersionId`
- `PATCH /scenes/:sceneId`
- `POST /storyboards/:storyboardVersionId/approve`

Script/storyboard generation must return schema-validated structured JSON, not unstructured prose only.

## 6. Media generation

### Scene images (implemented in M4)

Design: `docs/design/M4-design-review-package.md` §5–§7. Schemas: `packages/contracts/src/images.ts`.
The original per-scene sketch was replaced by storyboard-level endpoints: one request plans every
scene (or the listed ones), creates **one job per scene**, and reuses earlier results.

| Endpoint | Viewer | Editor/Owner | Notes |
|---|:-:|:-:|---|
| `POST /storyboards/:storyboardVersionId/images/estimate` | ✓ | ✓ | Body as below; returns the per-scene plan and price. No cost, nothing written |
| `POST /storyboards/:storyboardVersionId/images/generate` | 403 | 202 | Queues the scenes whose plan is `generate`; reuses keyframes of identical scenes |
| `GET /storyboards/:storyboardVersionId/images` | ✓ | ✓ | Per scene: keyframe, candidates (incl. identical earlier scenes), active and last job; `keyframesComplete` = gate 3 |
| `PUT /scenes/:sceneId/keyframe` | 403 | ✓ | `{ assetId }`: an approved, active image of the scene's content item (`409 KEYFRAME_INVALID` otherwise) |
| `POST /assets/:assetId/approve`, `/reject` | 403 | ✓ | Images and reference images only (`422 ASSET_NOT_REVIEWABLE`); a keyframe cannot be rejected (`409 KEYFRAME_INVALID`) |

Request body (estimate and generate):

```json
{
  "sceneIds": ["uuid"],
  "count": 1,
  "resolution": "2K",
  "modelKey": "bytedance-seed/seedream-5-0-flash",
  "seed": 7,
  "regenerate": false,
  "acceptUnknownCost": false
}
```

All fields are optional. Defaults: every scene without a keyframe, 1 candidate (at most 4), 2K
when the model supports it, the model routed to `image_generation` (`pnpm ai:registry route set
image_generation <modelKey> [--zdr]`). Per scene the plan says `generate`, `reuse_keyframe`
(an identical scene of an earlier storyboard version already has a keyframe), `skip_has_keyframe`,
`skip_existing_result` (identical inputs already produced candidates; `regenerate: true` overrides)
or `skip_in_progress`. A scene listed explicitly in `sceneIds` is generated even when it has a
keyframe. References sent with each scene: the character master's primary asset, the environment
master's primary asset, then the scene's reference assets; each must have a stored file.

Errors: `409 STORYBOARD_NOT_APPROVED` (gate 2), `409 INVALID_PIPELINE_STATE`, `409
GENERATION_IN_PROGRESS`, `422 NO_MODEL_ROUTE`, `422 MODEL_LIMITS` (resolution, aspect ratio or
seed not supported), `422 REFERENCES_EXCEED_MODEL_LIMIT`, `422 REFERENCE_FILE_MISSING`, `422
UNKNOWN_COST_NOT_ACCEPTED` (the plan is in `error.current`; resend with `acceptUnknownCost: true`),
`503 STORAGE_NOT_CONFIGURED`.

Content status: `storyboard_review`/`asset_review` → `generating_assets` when jobs are queued →
`asset_review` once the item's last image job ends with at least one candidate (otherwise back to
the starting status). Canceling the run (`POST /production-runs/:runId/cancel`) settles the same
way. Image jobs appear in `GET /generation-jobs/:jobId` and `GET /production-runs/:runId` with
`kind: image_generation`.

### Clips, voice-overs and voice profiles (implemented in M5)

Design: `docs/design/M5-design-review-package.md` §5–§11 (deviations §15). Schemas:
`packages/contracts/src/media.ts`. Like images, these are storyboard-level batches with one job per
scene; the original per-scene/per-content sketches are replaced.

| Endpoint | Viewer | Editor/Owner | Notes |
|---|:-:|:-:|---|
| `POST /storyboards/:storyboardVersionId/videos/estimate` | ✓ | ✓ | Per scene: action, scene seconds, billed seconds, price; total, `spendGuardUsd`, `providerRetainsInputs` |
| `POST /storyboards/:storyboardVersionId/videos/generate` | 403 | 202 | Same body + `confirmedEstimateUsd` (the total shown; `null` confirms an unknown one) |
| `GET /storyboards/:storyboardVersionId/videos` | ✓ | ✓ | Per scene: keyframe, clip, candidates, active/last job, provider `progress`; `clipsComplete` |
| `PUT /scenes/:sceneId/clip` | 403 | ✓ | `{ assetId }`: an approved clip of the scene or generated from its keyframe |
| `POST /generation-jobs/:jobId/recheck` | 403 | 202 | "Check again": an immediate status read of a running video job the provider accepted (free) |
| `POST /storyboards/:storyboardVersionId/voiceovers/estimate` | ✓ | ✓ | Per scene: action, characters, price (the content item's voice profile) |
| `POST /storyboards/:storyboardVersionId/voiceovers/generate` | 403 | 202 | Queues one TTS job per scene with voice-over text |
| `GET /storyboards/:storyboardVersionId/voiceovers` | ✓ | ✓ | Per scene: text, voice-over, candidates (generated + imported uploads), `exceedsScene`; `voiceoversComplete` |
| `PUT /scenes/:sceneId/voiceover` | 403 | ✓ | `{ assetId }`: an approved generated voice-over or imported `voiceover` upload |
| `GET /projects/:projectId/voice-profiles` | ✓ | ✓ | `?includeArchived=true` |
| `POST /projects/:projectId/voice-profiles` | 403 | 201 | `{ name, modelKey, voice, language, speed?, instructions? }`; the voice is checked against the model's voices |
| `PATCH /voice-profiles/:voiceProfileId` | 403 | ✓ | Past jobs keep their snapshot |
| `POST /voice-profiles/:voiceProfileId/archive` | 403 | ✓ | |
| `PATCH /content/:contentId` | 403 | ✓ | + `voiceProfileId` (active profile of the same project, or `null`) |
| `POST /assets/:assetId/approve`, `/reject` | 403 | ✓ | Now also clips (`video`) and `audio`; a selected clip/voice-over cannot be rejected (`409 SCENE_SELECTION_INVALID`) |

Video request body (estimate and generate):

```json
{
  "sceneIds": ["uuid"],
  "resolution": "720p",
  "generateAudio": false,
  "modelKey": "mock/still-video",
  "seed": 7,
  "regenerate": false,
  "acceptUnknownCost": false,
  "confirmedEstimateUsd": "0.6"
}
```

Defaults: every scene with a keyframe and no clip, 720p, no native audio, the model routed to
`video_generation` (`pnpm ai:registry route set video_generation <modelKey>`). The billed duration
is the smallest supported duration ≥ the scene. Plan actions: `generate`, `reuse_clip`,
`skip_has_clip`, `skip_existing_result`, `skip_in_progress`, `skip_no_keyframe`,
`skip_exceeds_model_maximum`. Voice-over actions: `generate`, `reuse_voiceover`,
`skip_has_voiceover`, `skip_existing_result`, `skip_in_progress`, `skip_no_text`.

Errors: `409 STORYBOARD_NOT_APPROVED`, `409 ESTIMATE_CHANGED` (no or a lower confirmed total; the
current plan is in `error.current`), `422 SPEND_GUARD` (above
`VIDEO_MAX_ESTIMATED_USD_PER_REQUEST`, default USD 5), `422 UNKNOWN_COST_NOT_ACCEPTED`, `409
VOICE_PROFILE_REQUIRED`, `409 CLIP_INVALID`, `409 VOICEOVER_INVALID`, `409 SCENE_SELECTION_INVALID`
(AC016), `409 JOB_NOT_RECHECKABLE`, `409 GENERATION_IN_PROGRESS`, `422 NO_MODEL_ROUTE`, `422
MODEL_LIMITS`, `422 REFERENCE_FILE_MISSING` (keyframe file), `503 STORAGE_NOT_CONFIGURED`.

Job error codes shown to the user (video): `SUBMIT_OUTCOME_UNKNOWN` (never resubmitted
automatically; regenerating may be charged twice), `PROVIDER_FAILED`/`_CANCELLED`/`_EXPIRED`,
`PROVIDER_TIMEOUT` (followed for 6 h), `OUTPUT_INVALID` (FFprobe), `OUTPUT_EXPIRED`. Canceling a
run with a submitted video records its invocation as `outcome_unknown` (`CANCELED_BY_USER`): the
provider has no cancel endpoint and may still charge.

Content status: as for images (`generating_assets` while any scene media job is active, then
`asset_review`).

All generation endpoints return job IDs and initial status. Do not hold an HTTP request open while waiting for long-running generation.

## 7. Assets and renders

Implemented in M1d (metadata only; decision D8). Schemas: `packages/contracts/src/assets.ts`.

| Endpoint | Role | Notes |
|---|---|---|
| `POST /projects/:projectId/assets` | editor | registers metadata; see rules below |
| `GET /projects/:projectId/assets` | viewer | paginated; filters `assetType`, `contentItemId`, `includeArchived` |
| `GET /assets/:assetId` | viewer | |
| `GET /assets/:assetId/lineage` | viewer | `?direction=ancestors\|descendants&depth=1..50`; descendants are breadth-first and paginated (`limit`, `cursor`) |
| `GET /assets/:assetId/usages` | viewer | character/environment versions referencing the asset (`primary` or `link`) |
| `PATCH /assets/:assetId` | editor | `label`, `metadata` only; `If-Match` |
| `POST /assets/:assetId/archive` | editor | `409 ASSET_IN_USE` while an approved version references it |

Registration rules: `storageKey` must start with `projects/<projectId>/` and contain no `.`/`..`
segments (`409 STORAGE_KEY_TAKEN` if already registered); `mimeType` must match `assetType`
(e.g. `reference`/`image`: PNG, JPEG, WebP; `render`: MP4); `sizeBytes` ≤ 10 GiB;
`checksumSha256` is 64 lowercase hex characters; `sourceType` is `upload`, `import` or `derived`
(`generated` is reserved for provider jobs in M4); `derived` requires a `sourceAssetId` of the
same project. File identity and lineage never change after registration.

### Asset files (implemented in M4a)

Design: `docs/design/M4-design-review-package.md` §4, ADR-0006 (amended).

| Endpoint | Role | Notes |
|---|---|---|
| `POST /projects/:projectId/assets/upload?assetType=reference\|image&filename=&label=&contentItemId=` | editor | The **raw image is the request body** (`Content-Type: image/png\|jpeg\|webp`, ≤ 25 MB). The server detects the type from the bytes, reads dimensions, computes SHA-256, stores the file write-once at `projects/{projectId}/assets/{assetId}/{sha256}.{ext}` and returns `201` with the asset (`sourceType: upload`). |
| `POST /projects/:projectId/assets/upload?assetType=audio&purpose=voiceover\|music&licenseNote=` | editor | M5a. The **raw audio file is the body** (MP3, WAV, M4A/AAC, ≤ 25 MB). Magic bytes and FFprobe decide the type; the measured duration is stored (`durationMs`), codec details in `metadata.audio`, `purpose` in `metadata.purpose`. `purpose` is required; `music` also needs `licenseNote` (`422 LICENSE_NOTE_REQUIRED`), stored as `sourceNote`. Without FFprobe: `503 MEDIA_TOOLS_MISSING`. |
| `GET /assets/:assetId/content` | viewer | Streams the file with `ETag: "<sha256>"` (`If-None-Match` → `304`) and `Cache-Control: private, max-age=300`. M5a: `Accept-Ranges: bytes`; one byte range (`Range: bytes=a-b`, `a-`, `-n`) answers `206` with `Content-Range`; a range outside the file answers `416 RANGE_NOT_SATISFIABLE` with `Content-Range: bytes */size`. |

Errors: `415 UNSUPPORTED_MEDIA` (not PNG/JPEG/WebP by its bytes), `415 MEDIA_TYPE_MISMATCH`
(`Content-Type` disagrees with the bytes), `413 MEDIA_TOO_LARGE` (file over the limit, or over
8192 px per side / 40 MP), `422 MEDIA_INVALID` (empty or unreadable header), `404
ASSET_CONTENT_MISSING` (a metadata-only asset registered before M4), `503 STORAGE_NOT_CONFIGURED`,
`503 STORAGE_UNAVAILABLE` (retryable).

Planned for later milestones:

- `GET /content/:contentId/assets`
- `GET /assets/:assetId`
- `POST /assets/:assetId/approve`
- `POST /assets/:assetId/reject`
- `POST /content/:contentId/renders`
- `GET /renders/:renderId`
- `POST /renders/:renderId/approve`
- `GET /renders/:renderId/download`

Downloads should use short-lived signed URLs.

## 8. Cost and model registry

### Implemented in M2 (read-only registry)

Design: `docs/design/M2-design-review-package.md` §8.2. Global (not project-scoped) data: any
authenticated user may read it (401 otherwise); nothing here is written through the API. Operators
edit the registry with `pnpm ai:registry` (`docs/LOCAL_DEVELOPMENT.md`). Credentials are never
returned; money is a decimal string in USD (`unitPriceUsd`), never a JSON number (ADR-0012).

| Endpoint | Response |
|---|---|
| `GET /ai/providers` | `{ data: AiProvider[] }`: `key`, `name`, `kind` (gateway/direct/mock), `status`, `configured` (credentials present in this deployment), terms and data-policy links |
| `GET /ai/models` | Paginated `AiModel[]`. Filters `capability`, `status`, `qualityTier`, `providerKey`. Each model lists its capabilities, supported parameters, modalities, limits, quality tier, status, free-variant flag and `activePrices` (one per metric and prompt-size tier; a metric with no price has unknown cost, never zero) |
| `GET /ai/models/:modelId` | `AiModel` plus `priceHistory` (append-only price rows with source, URL, effective and captured times) |

No endpoint calls a model in M2 (decision P7): the first caller is the M3 script job, through
`LlmService` (`apps/api/src/ai/llm.service.ts`).

### Planned

- `GET /projects/:projectId/usage`
- `GET /content/:contentId/costs`
- `GET /generation-jobs/:jobId`
- `GET /providers`
- `GET /models`
- Admin-only provider/model configuration endpoints.

Do not expose credentials in provider/model responses.

## 9. Job status events

Initial MVP may poll `GET /production-runs/:runId`. Later add SSE or WebSocket events:
- `run.started`
- `stage.started`
- `job.waiting_provider`
- `job.progress`
- `job.succeeded`
- `job.failed`
- `approval.required`
- `render.completed`

## 10. Error format

```json
{
  "error": {
    "code": "PROVIDER_RATE_LIMITED",
    "message": "The selected provider is temporarily rate limited.",
    "retryable": true,
    "correlationId": "uuid"
  }
}
```

Never return raw provider secrets, stack traces, or internal credentials.

Implemented in M0 by `apps/api/src/common/api-exception.filter.ts`. Unknown errors become
`500 INTERNAL_ERROR` with a generic message. `retryable` is `true` for 429/502/503/504. Error codes
are listed in `packages/contracts/src/errors.ts`. Common HTTP statuses have a dedicated code (for
example `412 PRECONDITION_FAILED`, `413 PAYLOAD_TOO_LARGE`, `428 PRECONDITION_REQUIRED`); any other
4xx uses `CLIENT_ERROR`, and a domain exception may set its own `code` (e.g. `BUDGET_EXCEEDED`).

Since M1, a domain error may also override `retryable`, and `400 VALIDATION_FAILED` adds
`details`, one entry per problem, prefixed by the request part:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is invalid.",
    "retryable": false,
    "correlationId": "uuid",
    "details": [{ "path": "body.email", "message": "Invalid email address" }]
  }
}
```

Database errors map to stable codes (`apps/api/src/common/database-error.mapper.ts`). Services
pre-check every rule, so these are a backstop for races and direct SQL:

| Database condition | Response |
|---|---|
| Unique violation | `409 EMAIL_TAKEN` / `SLUG_TAKEN` / `STORAGE_KEY_TAKEN`, otherwise `409 CONFLICT` |
| Foreign key violation (incl. cross-project composite FK) | `422 REFERENCE_NOT_FOUND` |
| CHECK violation | `422 CONSTRAINT_VIOLATION` |
| `AC001` / `AC009` | `409 VERSION_IMMUTABLE` |
| `AC002` | `409 VERSION_LINKS_FROZEN` |
| `AC003` / `AC004` | `409 MASTER_CONFLICT` |
| `AC005` | `409 ASSET_IDENTITY_IMMUTABLE` |
| `AC006` | `409 ARCHIVE_ONLY` |
| `AC007` | `409 LAST_OWNER` |
| `AC008` | `409 ASSET_IN_USE` |
| `AC010` | `409 ASSET_ARCHIVED` |
| `AC012` | `409 ARTIFACT_IMMUTABLE` (M3: a reviewed version cannot change; edits create new versions) |
| `AC013` | `409 STALE_STORYBOARD` (M3: pointer/staleness rules) |
| `AC014` | `409 CONTENT_MASTER_IMMUTABLE` (R0: a content item never moves to another master) |
| `AC015` | `409 KEYFRAME_INVALID` (M4: keyframe rules) |
| `AC011` | `409 LEDGER_IMMUTABLE` (M2: price/usage rows append-only; an invocation's outcome is recorded once) |
| `40001` / `40P01` | `409 CONCURRENT_MODIFICATION`, `retryable: true` (a `40001` is first retried once internally; a `40P01` is never retried, see below) |

Transaction retry policy (`apps/api/src/infrastructure/transaction-runner.ts`). Every attempt runs
at READ COMMITTED (ADR-0011 §6); the error that ends the last attempt propagates unchanged to the
mapper above:

| SQLSTATE | Behavior |
|---|---|
| `40001` (serialization failure) | Retry once; if the retry also fails, propagate the second error |
| `40P01` (deadlock) | Log `deadlock_detected` at error level (a defect: protocol paths cannot deadlock) and propagate immediately; never retried |
| `AC001`–`AC010` | No retry |
| Other errors | No retry |

M3 error codes: `BRIEF_INVALID` (422, details list the errors), `NO_MODEL_ROUTE` (422),
`GENERATION_IN_PROGRESS` (409, one active job per content item and kind), `INVALID_PIPELINE_STATE`
(409), `SCRIPT_NOT_APPROVED` (409), `STALE_STORYBOARD` (409), `ARTIFACT_IMMUTABLE` (409),
`NOT_CANCELABLE` (409).

## 11. API conventions

- Use UUID identifiers.
- Use cursor or page-based pagination consistently.
- Validate request payloads.
- Use idempotency keys for expensive operations.
- Return `202 Accepted` for queued generation operations.
- Document rate limits and permissions.
- Version breaking API changes under a new path.

Implemented conventions (M1):

- **Contracts**: every route declares `@Endpoint({ summary, params, query, body, responses, errors })`
  with Zod schemas (`apps/api/src/common/http/endpoint.ts`). The same schemas validate requests
  (all declared parts at once, after authentication) and generate the OpenAPI document. Request
  objects are strict: unknown keys are rejected.
- **OpenAPI 3.1**: `GET /openapi.json`, generated with `zod-openapi`. Served without
  authentication when `OPENAPI_PUBLIC=true` (the default outside production). A test fails if any
  registered route lacks `@Endpoint` metadata.
- **Pagination**: `?limit` (default 20, max 100) and `?cursor`. Responses are
  `{ "data": [...], "page": { "nextCursor": "…" | null, "limit": 20 } }`. Cursors are opaque
  (base64url of the last row's `createdAt` and `id`, ordered `createdAt DESC, id DESC`); an
  invalid cursor returns `400 INVALID_CURSOR`.
- **Optimistic concurrency**: mutable resources return `ETag: W/"<updatedAt epoch-ms>"` and
  `updatedAt`. `PATCH`, `PUT …/assets` and `POST …/approve` accept `If-Match`; a stale or
  malformed value returns `412 PRECONDITION_FAILED`. With `REQUIRE_IF_MATCH=true`, a missing
  header returns `428 PRECONDITION_REQUIRED`.
- **Security headers**: `helmet` defaults on every response; no `X-Powered-By`.
