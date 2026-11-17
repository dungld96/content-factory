# REST API Specification

Base path: `/api/v1`  
Format: JSON  
Authentication: session/JWT strategy to be selected during M0; all non-health endpoints must be protected in non-local environments.

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

## 1. Projects

### `POST /projects`
Create a project.

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
List accessible projects.

### `GET /projects/:projectId`
Get project details.

### `PATCH /projects/:projectId`
Update project metadata.

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

### `GET /projects/:projectId/content`
List content items with pagination and filters.

### `GET /content/:contentId`
Get item details and current production status.

### `PATCH /content/:contentId`
Update editable metadata/brief. Changes that invalidate generated outputs must create a new content revision or mark downstream outputs stale.

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
are listed in `packages/contracts/src/errors.ts`.

## 11. API conventions

- Use UUID identifiers.
- Use cursor or page-based pagination consistently.
- Validate request payloads.
- Use idempotency keys for expensive operations.
- Return `202 Accepted` for queued generation operations.
- Document rate limits and permissions.
- Version breaking API changes under a new path.
