# M4 Design Review Package — Image and Asset Management

- Status: **Revision 1, approved by the owner (2026-11-18)**: G1–G9 as proposed (OpenRouter +
  capped benchmark, SeaweedFS 4.54, bytes through the API). Implemented in slices M4a–M4e (§11).
- Date: 2026-11-18
- Baseline: M3 approved, R0 approved (`69785c2`); ADR-0006 (object storage), ADR-0012 (AI
  ledger), ADR-0013 (jobs), ADR-0015 (masters and variants)
- Inputs: `docs/design/m4/openrouter-image-verification.md` (provider facts), IMPLEMENTATION_PLAN
  §M4, CONTENT_PIPELINE stage 6, M3.5 review §7 (R1)

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                       | Section |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| G1  | First image provider: **OpenRouter Image API** (`POST /api/v1/images`), a second adapter in the existing OpenRouter integration              | §3      |
| G2  | Seed 3 candidate models, all **disabled**; run a capped paid benchmark (≤ USD 5) before the owner enables and routes one                     | §3.3    |
| G3  | Local/CI/staging object storage: **SeaweedFS 4.54** replaces MinIO (no longer on Docker Hub); ADR-0006 amended                               | §4.1    |
| G4  | Bytes go **through the API**: raw-body upload (≤ 25 MB images) and authenticated streaming reads; storage is never exposed to browsers in M4 | §4.2    |
| G5  | One image **job per scene**; 1 candidate per scene by default, up to 4 per request; candidates are `generated` assets                        | §5      |
| G6  | Scene keyframe approval is a **selection pointer** per scene; identical scenes in a newer storyboard version **reuse** the approved image    | §5.4    |
| G7  | Image prices as registry data (per image / megapixel / image token, with resolution variants); unknown estimates need explicit confirmation  | §6      |
| G8  | Image validation in pure JS (`image-size` + magic bytes) in M4; FFprobe arrives with video/render (M5/M6)                                    | §4.3    |
| G9  | Every image request sends `data_collection: deny`; ZDR is a per-route option the owner sets when routing to a model                          | §3.2    |

## 1. Scope

**In scope (IMPLEMENTATION_PLAN §M4):** image provider adapter; reference asset upload; image
generation jobs; asset lineage; candidate review/approval UI. Plus, from the approved roadmap:
R1 (stage descriptors for `short_video`, scene-scoped jobs) and the content-master UI deferred
from R0.

**Out of scope:** image editing (`image_edit`), vision evaluation (optional in CONTENT_PIPELINE;
later), video/TTS (M5), render (M6), budgets/circuit breakers (M7; M4 shows estimates and records
cost), presigned/browser-direct uploads (M5, for large video), new formats (R2).

**Acceptance (IMPLEMENTATION_PLAN §M4) and evidence:**

| Criterion                                           | Evidence                                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| At least one configured provider generates an image | Manual, budget-capped paid smoke (§9) against OpenRouter with the routed model; CI uses the mock provider                                       |
| Output stored in object storage                     | Worker integration test on real SeaweedFS + PostgreSQL + Redis: object exists, checksum and dimensions match the asset row                      |
| Asset links to prompt, model, inputs and job        | DB/API tests: `assets.generation_job_id` → job (`prompt_snapshot`, `model_id`, input ids), `asset_inputs` → reference assets, invocation → cost |

## 2. Where it sits

```text
content master ─┬─ variant (content item, short_video)
                │    approved storyboard (gate 2) ─ scenes 1..n
                │         └─ image job per scene ─▶ candidate assets ─▶ approved keyframe (gate 3)
                └─ … other variants
character/environment versions ─▶ reference assets (uploaded in M4) ─▶ input_references
```

R1: `packages/content-domain/formats` gains the `short_video` stage list — `script`, `storyboard`,
`images` (scope `unit` = scene) — with their gates. The API asks the descriptor whether a stage may
run; M3's hard-coded "storyboard needs an approved script" moves into it unchanged.

## 3. Image provider

### 3.1 Interface (`packages/ai-core`)

`ImageProvider` replaces the M2 placeholder (ADR-0004; no universal `generate()`):

```typescript
interface ImageRequest {
  modelKey: string; // registry key, e.g. "bytedance-seed/seedream-5-0-flash"
  prompt: string; // ≤ 8 000 chars
  negativePrompt?: string; // folded into the prompt when the model has no field for it
  aspectRatio: '9:16' | '1:1' | '16:9';
  resolution?: '1K' | '1.5K' | '2K';
  count: number; // 1–4, ≤ the model's n max
  seed?: number;
  references: { mimeType: string; bytes: Uint8Array }[]; // ≤ the model's reference max
}
interface ImageResult {
  images: { mimeType: string; bytes: Uint8Array }[];
  usage: { reportedCostUsd: UsdAmount | null; outputTokens?: number; inputTokens?: number };
  providerRequestId: string | null;
  servedModel: string | null;
}
interface ImageProvider {
  generate(req: ImageRequest, ctx: GenerationContext, signal: AbortSignal): Promise<ImageResult>;
}
```

Validated with zod before any network call; errors normalized to the M2 `ProviderError` codes.
`MockImageProvider` (deterministic PNGs from a seed, configurable failures) for tests and E2E.

### 3.2 OpenRouter adapter (G1, G9)

- `@acf/ai-core/openrouter` gains `OpenRouterImageProvider` using the same config, key and HTTP
  client rules as the text adapter (no new dependency, `fetch`).
- Request: `model`, `prompt`, `aspect_ratio`, `resolution` when supported, `n`, `seed` when
  supported, `input_references` as base64 data URLs, `user` = hashed project id, and
  `provider: { only: [routedEndpoint], allow_fallbacks: false, data_collection: "deny",
zdr?: true }`.
- Parameters the model's endpoint does not list are **not sent**; a request needing one
  (e.g. 4 candidates on an `n` max 1 model) is split into sequential calls of `n = 1`, or refused
  at routing when that is impossible (references above the model's max → `422`).
- Response: decode `b64_json`; `media_type` must be present and match the decoded magic bytes;
  `usage.cost` → `reported` cost; tokens recorded when present.
- Timeout 240 s per call (the docs show 94 s for a high-quality call); BullMQ lock 300 s for image
  jobs. A timeout is `outcome_unknown` (M2); OpenRouter's all-or-nothing billing makes the retry
  cost-safe.

### 3.3 Models (G2)

`pnpm ai:registry import-images` reads the public catalog and endpoints into the registry
(capability `image_generation`, supported parameters incl. `n`/reference ranges, aspect ratios,
prices). Everything imported is **disabled**. Proposed benchmark set (verification record §2):

| Candidate                              | Why                                                | Price at 2K 9:16 |
| -------------------------------------- | -------------------------------------------------- | ---------------- |
| `black-forest-labs/flux-3-image-klein` | Cheapest per image; seed; 10 references            | $0.014           |
| `bytedance-seed/seedream-5-0-flash`    | Flat price, up to 14 references, free input images | $0.018           |
| `qwen/qwen-image-2.1-turbo`            | Flat price, `n` up to 6 (cheap multi-candidate)    | $0.0184          |

Benchmark (AI_PROVIDER_STRATEGY §9): same 3 scene prompts × 1 character reference × 3 models ×
10 samples ≈ 90 images ≈ USD 1.5 at catalog prices; hard cap USD 5 in the script. Scores are
entered by the owner; the winner is enabled and routed (`ai_task_routes.image_generation`).
Token-priced models (Google, OpenAI) can be benchmarked later; their per-image cost is unknown
until measured.

## 4. Storage and assets

### 4.1 Object storage (G3)

ADR-0006 chose MinIO for local development; `minio/minio` no longer exists on Docker Hub
(checked 2026-11-18, HTTP 404). Options with pinned, current images:

| Option               | Image                      | License    | Notes                                                  |
| -------------------- | -------------------------- | ---------- | ------------------------------------------------------ |
| **SeaweedFS** (rec.) | `chrislusf/seaweedfs:4.54` | Apache-2.0 | Long-lived project; single container `weed server -s3` |
| RustFS               | `rustfs/rustfs:1.0.6`      | Apache-2.0 | MinIO-like; 1.0 line is weeks old                      |
| Garage               | `dxflrs/garage:v2.5.0`     | AGPL-3.0   | Mature for small clusters; more setup (layout, keys)   |

The app talks S3 only (`@aws-sdk/client-s3@3.1171.0`, Apache-2.0, Node ≥ 20), so the server is
swappable (R2/S3/GCS interop) by configuration. Staging (ADR-0014) runs the same container on the
VM with a named volume on the persistent disk; backups join the existing VM disk snapshots.
Slice M4a starts with a compatibility test (put with checksum, head, ranged get, list, delete
denied to the app key); the fallback is RustFS, recorded in the ADR.

`packages/storage` (new): `ObjectStore` interface (`put(key, bytes, {contentType, sha256})`,
`get(key, range?)`, `head(key)`), S3 implementation, in-memory fake for unit tests. Keys:
`projects/{projectId}/assets/{assetId}/{sha256}.{ext}` — immutable, content-addressed (CLAUDE.md
§8). The application key has no delete permission; archived assets keep their bytes.

### 4.2 Upload and read paths (G4)

- `POST /projects/:projectId/assets/upload?assetType=reference|image&filename=&label=&contentItemId=`
  with the raw image as the body (`Content-Type: image/png|jpeg|webp`, ≤ 25 MB, per-route body
  limit). The API streams to a temporary buffer, validates (§4.3), writes the object, then inserts
  the asset (`source_type: upload`) in one request. Write-then-insert can orphan an object if the
  insert fails; orphans are harmless (private, content-addressed) and a sweep is listed for M7.
- `GET /assets/:assetId/content` (viewer+) streams the bytes with `ETag` = checksum,
  `Cache-Control: private, max-age=300`; `?variant=thumb` is out of scope (browser scales).
- The M1 metadata-only registration stays for `import`/`derived` sources.
- Signed URLs (ADR-0006) are deferred to M5, where video size makes API streaming expensive.

### 4.3 Validation (G8)

Magic bytes decide the type (PNG/JPEG/WebP only); the declared `Content-Type` must agree;
`image-size@2.1.0` (MIT, pure JS) reads dimensions; limits: ≤ 25 MB, ≤ 8192 px per side,
≤ 40 MP; SHA-256 computed server-side. Generated images get the same checks. No re-encoding, no
upscaling (CLAUDE.md §8). FFprobe is introduced in M5/M6 with the media worker image.

### 4.4 Lineage (DB)

| Change                                                                     | Rule                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `assets.generation_job_id` (composite FK)                                  | Required iff `source_type = generated` (CHECK); immutable (existing `AC005`)                           |
| `assets.storyboard_scene_id` (composite FK, nullable)                      | The scene a generated candidate was made for                                                           |
| `asset_inputs(asset_id, input_asset_id, role)` (append-only, same project) | Every reference image sent with the generation (`role`: `character`, `environment`, `scene_reference`) |

Prompt, model and parameters live on the job (`prompt_snapshot`, `model_id`, `input`); cost on
the job's invocations. `GET /assets/:assetId/lineage` (M1) gains the job and inputs.

## 5. Image generation

### 5.1 Jobs (G5)

- `GenerationJobKind` += `image_generation`; `generation_jobs.storyboard_scene_id` (nullable,
  composite FK, required for image jobs: CHECK). `active_key` = `"{sceneId}:image_generation"`
  for image jobs: at most one active job per scene.
- Input (`imageJobInputSchema`): scene id, storyboard version id, image/negative prompt,
  aspect ratio, resolution, candidate count, seed?, reference asset ids (character master,
  environment master, scene references), model route, quality tier.
- Execution key: kind, **scene content hash** (prompts, character/environment version ids,
  reference asset ids, aspect ratio, resolution), candidate count, template (`image.v1`),
  model id. It does not include the scene id, so an unchanged scene in a newer storyboard version
  maps to the same key (§5.4).
- One production run per request: "generate images" for a storyboard creates one job per scene
  without an approved keyframe (or the scenes listed); "regenerate scene N" creates one job.

### 5.2 Prompt (`image.v1`)

Built deterministically from the scene (no LLM call in M4): visual description + image prompt,
shot type and camera angle, aspect ratio, "consistent with the reference images of {character}
and {environment}", negative prompt appended as "Avoid: …" when the model has no negative field.
The resolved prompt is stored on the job. Prompt refinement by an LLM is a later option
(AI_PROVIDER_STRATEGY §5, economy tier).

### 5.3 Worker processing

1. Load job; `running`, `attempt += 1` (M3 rules).
2. Load reference bytes from storage (≤ model max; character master primary asset first).
3. Record invocation (`started`), call the provider, record outcome and cost (M2 ledger).
4. For each returned image: validate (§4.3), write object, insert asset (`generated`, `image`,
   `pending`, job, scene, content item) and `asset_inputs` — all assets of one job in one
   transaction with the job's `succeeded` transition.
5. Errors: M3 retry policy (3 attempts, exponential + jitter, `Retry-After`); content-policy
   blocks and invalid requests never retry; DLQ copy after exhaustion.

### 5.4 Review and selection (G6)

- Candidate review: `approve` / `reject` on an image asset (editor+) sets
  `assets.approval_status` once per decision (existing column; `pending → approved|rejected`).
- Selection: `scene_keyframes(storyboard_scene_id PK, asset_id, selected_by_id, selected_at)` —
  the approved keyframe of a scene. Selecting another approved candidate moves the pointer
  (history in an append-only `scene_keyframe_events`). Trigger: the asset is an approved image of
  the same project generated for, or reused into, this scene (`AC015`).
- Reuse across storyboard versions: when a newer storyboard version is approved, scenes whose
  content hash equals an older scene with a keyframe get that keyframe copied as a pointer
  (same asset, no regeneration — CLAUDE.md §2.9); changed scenes start empty.
- Gate 3 ("assets approved"): every scene of the approved storyboard has a keyframe. Computed,
  shown in the UI; M5 video jobs require it.

### 5.5 Content status

| From                                | Event                                  | To                  |
| ----------------------------------- | -------------------------------------- | ------------------- |
| `storyboard_review`, `asset_review` | image jobs queued                      | `generating_assets` |
| `generating_assets`                 | last active image job of the run ended | `asset_review`      |
| `generating_assets`                 | all jobs of the run failed/canceled    | previous status     |

Approvals and selections do not change the status (M3 convention); gate 3 is computed.

## 6. Cost (G7)

- `AiPriceMetric` += `output_image`, `input_image`, `output_megapixel`, `input_megapixel`,
  `output_image_token`, `input_image_token`; `ai_model_prices.variant` (nullable, part of the
  unique key) for resolution tiers (`1k`, `2k`, `high_resolution`).
- Per call: `usage.cost` → `reported`; registry estimate → `estimated` (per-image × count, or
  per-megapixel × actual pixels); token-priced models without token counts → `unknown` — never 0.
- Before generating, the API returns an **estimate** (`POST …/images/estimate`, also embedded in
  the generate response): sum over jobs, or `unknown`. Generating with an unknown estimate
  requires `acceptUnknownCost: true` from the editor (COST_STRATEGY §3). Hard budgets are M7.

## 7. API (base `/api/v1`)

| Endpoint                                                 | Viewer | Editor/Owner | Notes                                                                 |
| -------------------------------------------------------- | :----: | :----------: | --------------------------------------------------------------------- |
| `POST /projects/:projectId/assets/upload`                |  403   |     201      | Raw body (§4.2)                                                       |
| `GET /assets/:assetId/content`                           |   ✓    |      ✓       | Streams bytes                                                         |
| `POST /assets/:assetId/approve`, `/reject`               |  403   |      ✓       | Image candidates and uploads                                          |
| `POST /storyboards/:storyboardVersionId/images/estimate` |   ✓    |      ✓       | `{ sceneIds?, count?, resolution?, modelKey? }` → per-scene and total |
| `POST /storyboards/:storyboardVersionId/images/generate` |  403   |     202      | Same body + `acceptUnknownCost?`; approved storyboard only (`409`)    |
| `GET /storyboards/:storyboardVersionId/images`           |   ✓    |      ✓       | Per scene: keyframe, candidates, active job, cost                     |
| `PUT /scenes/:sceneId/keyframe`                          |  403   |      ✓       | `{ assetId }`; approved candidate only                                |

New error codes: `STORYBOARD_NOT_APPROVED` (409), `UNKNOWN_COST_NOT_ACCEPTED` (422),
`UNSUPPORTED_MEDIA` (415), `MEDIA_TOO_LARGE` (413), `REFERENCES_EXCEED_MODEL_LIMIT` (422),
`KEYFRAME_INVALID` (409, `AC015`). All endpoints join the permission matrix.

## 8. Web UI

- **Masters** (deferred from R0): project page lists masters with variants; master page shows the
  brief, "master changed" badges, "create variant" form, resync button.
- **References**: upload on character/environment version pages and an asset picker.
- **Images** (storyboard page, approved version): scene grid — keyframe, candidates, status,
  cost; "Estimate & generate all", per-scene "Regenerate", approve/reject, "Use as keyframe";
  gate-3 indicator. Polling as in M3.

## 9. Testing

| Layer               | What                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit                | image request validation; parameter capping/splitting; prompt `image.v1`; execution key incl. reuse; magic bytes and limits; cost estimate (per image/MP/token, unknown) |
| Contract (fixtures) | OpenRouter Image API success (b64 + usage), 400/402/403/429/502/timeout, missing `media_type`, mismatched type                                                           |
| Storage integration | SeaweedFS: put/head/get/range, checksum, delete denied                                                                                                                   |
| DB integration      | migration `m4_images`, CHECKs, `AC015`, lineage FKs, lock matrix (select keyframe vs new storyboard approval)                                                            |
| Worker integration  | real PostgreSQL + Redis + SeaweedFS + mock provider: success, multi-candidate split, retry, policy block, timeout, reuse                                                 |
| API integration     | every endpoint, permission matrix, gates, estimates, uploads (wrong type, oversize)                                                                                      |
| E2E (Playwright)    | upload reference → … → approve storyboard → estimate → generate (mock) → approve candidate → keyframe → gate 3                                                           |
| Paid smoke (manual) | `pnpm ai:smoke:image` with explicit `--max-usd`, default 0.10; benchmark script capped at 5                                                                              |

## 10. Risks

| ID  | Risk                                                                      | Mitigation                                                                                                 |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S1  | Direct providers (OpenAI, Google, BFL) unverifiable from this environment | Gateway first (documented capability); direct adapters later via the same interface once hosts are allowed |
| S2  | Character consistency from references varies a lot per model              | Benchmark with the real character before routing; up to 4 candidates; human selection                      |
| S3  | Sending character masters to providers (AI_PROVIDER_STRATEGY §10)         | `data_collection: deny` always; ZDR per route; owner confirms provider terms when enabling a model         |
| S4  | Long synchronous calls hold worker slots                                  | Image concurrency separate from text (default 2); 240 s timeout                                            |
| S5  | SeaweedFS behaviour differs from S3 in edge cases                         | Compatibility test first; only basic S3 operations used; RustFS fallback                                   |
| S6  | Orphan objects after a failed insert                                      | Private, content-addressed, no cost of note; sweep in M7                                                   |
| S7  | 1K/2K outputs at 9:16 may be below 1080×1920                              | Record real dimensions; never upscale silently; render (M6) decides scaling and reports it                 |

## 11. Implementation plan (each slice tested before the next)

| Slice | Scope                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4a   | SeaweedFS in local/CI/staging compose; `packages/storage`; compatibility test; upload + content endpoints; validation; ADR-0006 amendment                                                         |
| M4b   | `ImageProvider` interface, OpenRouter image adapter, mock provider, fixture contract tests; registry price metrics/variants; `import-images` CLI; smoke script                                    |
| M4c   | Migration `m4_images` (job kind, scene link, asset lineage, keyframes, triggers); worker image processor; R1 stage descriptors; worker tests                                                      |
| M4d   | API: estimate, generate, images view, approve/reject, keyframe; status transitions; permission matrix                                                                                             |
| M4e   | Web UI (masters, references, scene images); Playwright E2E with the mock provider; docs (API_SPEC, DATABASE, CONTENT_PIPELINE, AI_PROVIDER_STRATEGY, COST_STRATEGY); benchmark run with the owner |
