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

- `POST /projects/:projectId/characters`
- `GET /projects/:projectId/characters`
- `POST /characters/:characterId/versions`
- `POST /projects/:projectId/environments`
- `POST /environments/:environmentId/versions`

Reference asset upload should use a presigned upload flow. A version can be marked approved only by an authorized editor/admin.

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

### `POST /scenes/:sceneId/image-generations`
Request:
```json
{
  "providerPreference": ["provider-a", "provider-b"],
  "qualityTier": "balanced",
  "referenceAssetIds": ["uuid"],
  "promptOverride": null,
  "idempotencyKey": "unique-key"
}
```

### `POST /scenes/:sceneId/video-generations`
Request:
```json
{
  "sourceImageAssetId": "uuid",
  "providerPreference": ["provider-x"],
  "qualityTier": "balanced",
  "durationSeconds": 5,
  "aspectRatio": "9:16",
  "idempotencyKey": "unique-key"
}
```

### `POST /content/:contentId/tts-generations`
Request:
```json
{
  "scriptVersionId": "uuid",
  "voiceProfileId": "uuid",
  "language": "vi",
  "idempotencyKey": "unique-key"
}
```

All generation endpoints return a job ID and initial status. Do not hold an HTTP request open while waiting for long-running generation.

## 7. Assets and renders

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
| `40001` / `40P01` | `409 CONCURRENT_MODIFICATION`, `retryable: true` (transactions retry once internally first; a `40P01` is also logged as a defect) |

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
