# P2a Design Review Package — Asset Library Integrity

- Status: **Revision 1, approved by the owner (2026-11-20)**: A1–A3 as proposed.
- Date: 2026-11-20
- Baseline: MVP complete (M0–M8.5); P3 implemented. Input: `docs/post-mvp/POST_MVP_AUDIT.md`
  §A2, §B2, §C2 (steps 1–3 of P2).

P2a fixes what is wrong in the Asset Library before anything is added to it. The Library stays
the only place files are uploaded; production keeps binding assets by their real IDs. Features
(asset picker, character and environment pages, scene references, collections, server-side
search and paging) follow in **P2b**, a separate package.

## 0. Decisions requested

| ID  | Proposal (recommended)                                                                                                                                                                                                                                                                                                    | Finding                                                                                                                                                 | Section |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A1  | **Review in the Library**: approve and reject reference images, images, clips and audio from the Library's asset panel (editors); a "Needs review" filter; edit the label; archive. Uses the existing endpoints                                                                                                           | Uploaded music must be approved to be used, but no screen can approve it                                                                                | §2      |
| A2  | **System metadata is immutable**: the keys the platform writes (`purpose`, probe data, the reuse hashes, …) can no longer be changed or removed. The API refuses them in `PATCH` and registration (`422 METADATA_KEY_RESERVED`) and keeps the stored values; the database trigger `acf_asset_guard` enforces it (`AC005`) | `PATCH /assets/:id` replaces the whole `metadata`, including the keys that decide music eligibility and the reuse of paid images, clips and voice-overs | §3      |
| A3  | **Show real production lineage**: new `GET /assets/:assetId/inputs` (what an asset was made from, with role); `GET /assets/:assetId/usages` gains an optional `production` list (generation input, keyframe/clip/voice-over selection, scene reference, render output). The Library panel shows both                      | Generated assets show "Nothing (original asset)"; "Used by" lists only character/environment versions                                                   | §4      |

**Out of scope (P2b):** asset picker, character/environment UI, brief and scene reference
selection, collections, server-side search and paging, an immutable `purpose` column.

**One migration** (A2: replaces a trigger function; no table or column change). API changes are
additive: one endpoint, one optional response field, one error code.

## 1. Acceptance

| Criterion                                                          | Evidence                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uploaded music can be approved and used without the API            | E2E: upload music → approve in the Library → offered on the render panel                                                                                                                                                                                                          |
| Reviewing in the Library respects the existing rules               | API integration (existing): a selected keyframe/clip/voice-over cannot be rejected (`AC015`/`AC016`); viewers get `403`. E2E: viewer sees no review controls                                                                                                                      |
| System metadata cannot change                                      | Database integration: a direct `UPDATE` changing or removing a reserved key fails with `AC005`; adding a non-reserved key succeeds. API integration: `PATCH` with a reserved key → `422`; `PATCH` with other keys keeps reserved values; registration with a reserved key → `422` |
| Reuse still works                                                  | Existing reuse tests (images, clips, voice-overs) pass unchanged                                                                                                                                                                                                                  |
| A generated asset shows what it was made from and where it is used | API integration: a clip lists its keyframe (`keyframe`); a keyframe lists the clip made from it, its selection and the render that used it. E2E: Library panel shows "Made from" and "Used in"                                                                                    |
| Nothing else changes                                               | Existing suites pass; permission matrix extended                                                                                                                                                                                                                                  |

## 2. Review in the Library (A1)

**Today.** `POST /assets/:assetId/approve|reject` (`ImagesService.review`,
`apps/api/src/generation/images.service.ts:392`) accepts images, reference images, clips and audio
(editor). The Library panel (`apps/web/src/app/(studio)/assets/asset-browser.tsx`,
`LineagePanel`) is read-only. The render panel says "upload a music file … and approve it in the
Asset library" (`render-panel.tsx:192`), which is not possible.

**Change (web only).** In `LineagePanel`, for editors of the asset's project:

- **Approve / Reject** for `reference`, `image`, `video` and `audio` assets that are not archived
  (same endpoints and errors as the scene tabs; `409 KEYFRAME_INVALID` /
  `SCENE_SELECTION_INVALID` shown as "In use in a scene; choose another first").
- **Label** edit (`PATCH /assets/:id` with `label` only) and **Archive** (`POST …/archive`;
  `409 ASSET_IN_USE` shown with its message).
- A "Needs review" option in the Library filters (approval status `pending`, on the loaded list).
- The role comes from the project list the page already loads (`ProjectDto.role`).

No API change. Uploads stay in the Library only (no stage-level upload).

## 3. Immutable system metadata (A2)

**Today.** The platform writes these keys into `assets.metadata` and later reads them:

| Key                                                                                                   | Written by                                 | Read by                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `purpose`                                                                                             | Upload (`AssetsService.upload`), TTS jobs  | Voice-over candidates (`voiceovers.service.ts:262`), music options and validation (`renders.service.ts:445`, `:599`) |
| `sceneHash`                                                                                           | Image jobs (`generation-processor.ts:677`) | Image reuse (`images.service.ts:601`)                                                                                |
| `clipHash`                                                                                            | Clip jobs (`media-jobs.ts:434`)            | Clip reuse (`videos.service.ts:655`)                                                                                 |
| `voiceoverHash`                                                                                       | TTS jobs (`media-jobs.ts:554`)             | Voice-over reuse (`voiceovers.service.ts:288`, `:553`)                                                               |
| `model`                                                                                               | Image, clip, TTS jobs                      | Render manifest fallback (`renders.service.ts:562`)                                                                  |
| `audio`, `video`, `requestedSeconds`, `resolution`, `voice`, `language`, `characters`, `exceedsScene` | Upload probe, clip and TTS jobs            | Library display, voice-over overrun flag                                                                             |
| `renderId`, `upscaledFrom`, `cues`, `thumbnail`                                                       | Render jobs (`render-jobs.ts:182-192`)     | Render package                                                                                                       |

`AssetsService.update` writes `metadata` as given (`assets.service.ts:426`), so an editor can
change or delete any of them. `POST /projects/:id/assets` (registration) accepts any metadata,
so a reserved key can also be forged at creation.

**Change.**

1. `packages/content-domain/src/assets.ts` (new, browser-safe via `schemas`):
   `SYSTEM_METADATA_KEYS` — the 17 keys above.
2. API (`AssetsService`):
   - `update`: a request whose `metadata` contains a reserved key → `422 METADATA_KEY_RESERVED`
     (the key named in `details`); otherwise the stored reserved keys are merged back, so a
     `PATCH` never removes them. Other keys keep today's replace semantics.
   - `register`: a reserved key in `metadata` → the same `422`.
   - `ApiErrorCode.MetadataKeyReserved` added to `packages/contracts/src/errors.ts`.
3. Database, migration `p2_asset_metadata_guard`: `CREATE OR REPLACE FUNCTION acf_asset_guard()`
   with the existing checks unchanged, plus: for each reserved key,
   `(NEW.metadata -> k) IS DISTINCT FROM (OLD.metadata -> k)` raises `AC005` ("asset metadata key
   %s is immutable"). The key list in SQL and in TypeScript is checked equal by a database
   integration test.

Inserts are unaffected (the worker and upload write the keys when the row is created). No
existing data is rewritten.

## 4. Production lineage (A3)

**Today.** `GET /assets/:id/lineage` follows only `assets.source_asset_id` (derived files);
`GET /assets/:id/usages` lists only character/environment versions
(`AssetsService.lineage`, `usages`). The worker records every generation input in `asset_inputs`
(`role`: `character`, `environment`, `scene_reference`, `keyframe`, `clip`, `voiceover`, `music`),
but the API never reads it.

**Change (additive).**

- `GET /assets/:assetId/inputs` (viewer): `{ data: [{ role, asset }] }` from `asset_inputs` where
  `asset_id = :assetId`, newest input first. Schema `assetInputListSchema`.
- `GET /assets/:assetId/usages`: the response gains `production` (always present, possibly empty;
  existing `data` unchanged):

| `kind`                            | From                                                                  | Fields                                                                     |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `generation_input`                | `asset_inputs.input_asset_id = :assetId`                              | `role`, `assetId` (the asset made from it), `contentItemId`                |
| `keyframe` / `clip` / `voiceover` | `scene_keyframes` / `scene_clips` / `scene_voiceovers`                | `storyboardSceneId`, `sceneNumber`, `storyboardVersionId`, `contentItemId` |
| `scene_reference`                 | `storyboard_scene_assets`                                             | same as above                                                              |
| `render_output`                   | `renders.video_asset_id` / `subtitle_asset_id` / `thumbnail_asset_id` | `renderId`, `contentItemId`                                                |

Every row is limited to the asset's own project (composite foreign keys already guarantee it).
At most 100 rows per kind, newest first.

- Web `LineagePanel`: "Made from" (role + name, linked) and "Used in" (kind, content item link,
  scene number); "Derived from" stays for derived files.

## 5. Tests

| Level                | Tests                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                 | `SYSTEM_METADATA_KEYS` merge/refusal helper in `AssetsService` (pure function)                                                                                                                                 |
| Database integration | Reserved-key `UPDATE` → `AC005` for change and removal; non-reserved key update allowed; SQL key list equals `SYSTEM_METADATA_KEYS`; `schema-objects` still finds the trigger                                  |
| API integration      | `PATCH` and registration with reserved keys → `422`; `PATCH` keeps reserved values; `/inputs` and `usages.production` for a keyframe → clip → render chain; viewer access; permission matrix row for `/inputs` |
| E2E                  | Library: approve uploaded music, then use it in a render; "Made from"/"Used in" shown for a generated clip; viewer has no review controls                                                                      |

All with mock providers. As for P3, the integration and E2E suites need the full local stack
(`pnpm infra:up`).

## 6. Implementation plan

| Slice | Content                                     | Changes                                                |
| ----- | ------------------------------------------- | ------------------------------------------------------ |
| P2a-1 | A1 review, label and archive in the Library | web                                                    |
| P2a-2 | A2 reserved metadata keys                   | content-domain, contracts (error code), API, migration |
| P2a-3 | A3 inputs and production usages             | contracts (additive), API, web                         |

P2a-2 is the only slice with a migration; it lands before P2b's picker relies on `purpose`.

## 7. Risks

- **Generic key names** (`model`, `language`, `voice`) are reserved: a client that registered its
  own value under one of them can no longer change it. No client does today (the web never edits
  metadata).
- **Values edited before the migration** stay as they are; the guard only stops future changes.
  An operator can list suspicious rows (a reuse hash on a non-generated asset) with one query
  before deploying; the package adds it to the deploy notes.
- **Review from the Library affects selections**: rejecting is refused while an asset is
  selected (existing triggers), so a past render's inputs never change; its manifest is frozen.
- **`usages` grows**: the extra queries use existing indexes (`asset_inputs.input_asset_id`,
  `asset_id` on the selection and scene-reference tables, the render asset columns) and are
  capped per kind.
