# P2b Design Review Package — Asset Library Features

- Status: **Revision 1, approved by the owner (2026-11-21)** by standing instruction ("follow your
  recommendations until all packages are complete"): L1–L6 as proposed; collections per project.
  Slices P2b-1–P2b-4 implemented (§10); API integration and E2E verification pending.
- Date: 2026-11-21
- Baseline: P2a implemented (Library review, immutable system metadata, production lineage).
  Input: `docs/post-mvp/POST_MVP_AUDIT.md` §B2, §C2 (steps 4–7).

P2b lets producers find assets and bind them to production from the Library. The Library stays
the only place files are uploaded; every binding stores the asset's real ID and goes through an
existing versioned path (character/environment versions, storyboard versions), so history never
changes.

## 0. Decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                        | Section |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| L1  | **Server-side filters**: `GET /projects/:id/assets` gains `purpose`, `approvalStatus`, `q` (file name or label) and `collectionId` (additive). The Library pages through results instead of loading everything                                                                                                                                                  | §2      |
| L2  | **Asset picker**: one shared web dialog to choose existing Library assets (filtered by type, purpose, search, collection). Used by L3–L4. It never uploads                                                                                                                                                                                                      | §3      |
| L3  | **Characters and environments pages**: list, create, versions (draft with description and Library references, approve), master shown. Uses the existing M1 API (`If-Match` on approval)                                                                                                                                                                         | §4      |
| L4  | **Bind references**: the brief chooses a character and an environment (`characterId`, `environmentId`, already in the brief schema); the scene editor chooses scene reference assets (`requiredReferenceAssetIds`, already editable). The API now checks scene references: same project, active, `reference` or `image`, not rejected (`422 REFERENCE_INVALID`) | §5      |
| L5  | **Collections, per project**: `asset_collections` and `asset_collection_items` (migration). Membership is organisational only: no production path reads it, so it never changes a generation's inputs                                                                                                                                                           | §6      |
| L6  | **No immutable `purpose` column**: the P2a trigger already freezes `metadata.purpose`; a column would duplicate it                                                                                                                                                                                                                                              | —       |

**Out of scope:** cross-project collections, bulk operations, asset replacement (a new file is a
new asset, by design), automatic tagging.

## 1. Acceptance

| Criterion                                                                                              | Evidence                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Library filters on the server                                                                      | API integration: each filter; paging with cursor                                                                                                                               |
| A scene's references are Library assets, stored by ID, and editing them makes a new storyboard version | API integration: edit with valid ids → new version with `storyboard_scene_assets`; archived / other project / rejected / wrong type → `422`                                    |
| A character version links Library assets and its approval makes it the master                          | Existing brand integration tests (unchanged API); web uses them                                                                                                                |
| Collections never affect production                                                                    | API integration: adding/removing an asset from a collection changes no job input, execution key or selection; collection rows are project-isolated (`404` for another project) |
| No stage offers an upload                                                                              | Code review: only `UploadAssetButton` posts to `/assets/upload`                                                                                                                |

## 2. Server-side filters (L1)

`listAssetsQuerySchema` gains `purpose` (`voiceover` \| `music`), `approvalStatus`, `q` (1–100
characters, case-insensitive substring of `original_filename` or `label`) and `collectionId`.
`AssetsService.list` adds them to the existing keyset query. The Library page requests one page
per project (newest 60, with the filters) and shows "Show more" per project via the cursor.

## 3. Asset picker (L2)

`apps/web/src/components/asset-picker.tsx`: a `Modal` with search, type and collection filters
over `GET /projects/:id/assets`, thumbnails for images, players for audio/video, single or multiple
selection; returns asset IDs. Disabled entries: archived, rejected.

## 4. Characters and environments (L3)

`apps/web/src/app/(studio)/projects/[projectId]/brand/page.tsx` (link from the project page):

- characters and environments with their master version;
- create (name, slug, description);
- new draft version: description, primary reference and other references from the picker
  (`POST /characters/:id/versions`, `PUT /character-versions/:id/assets`);
- approve a draft (`If-Match` with the version ETag) — the M1 rules (`STALE_DRAFT`,
  `ASSET_ARCHIVED`) are shown as returned.

## 5. Bind references (L4)

- Brief: `NewContentForm` and the master brief form get optional Character and Environment selects
  (entities with an approved master only). Storyboards pin the version used (existing behaviour).
- Scene editor (`SceneEditor`): a References field with the picker; saving sends
  `requiredReferenceAssetIds` (new storyboard version, as every edit).
- `ArtifactsService.editScene`: before writing, every referenced asset must exist in the item's
  project, be active, be `reference` or `image`, and not be `rejected`; otherwise
  `422 REFERENCE_INVALID` naming the asset in `details`. Image generation keeps its file check
  (`REFERENCE_FILE_MISSING`).

## 6. Collections (L5)

Migration `p2b_asset_collections`:

```text
asset_collections
  id, project_id (FK projects), name varchar(100), created_by_id (FK users),
  archived_at, created_at, updated_at
  unique (project_id, id); unique (project_id, lower(name)) where archived_at is null
  no hard delete (acf_forbid_hard_delete)

asset_collection_items
  project_id, collection_id, asset_id, added_by_id (FK users), added_at
  PK (collection_id, asset_id)
  FK (project_id, collection_id) → asset_collections; FK (project_id, asset_id) → assets
  index (asset_id)
```

| Endpoint                                            | Role   | Notes                                                    |
| --------------------------------------------------- | ------ | -------------------------------------------------------- |
| `GET /projects/:projectId/collections`              | viewer | Active collections with item counts (`includeArchived`)  |
| `POST /projects/:projectId/collections`             | editor | `{ name }`; `409 NAME_TAKEN` for a duplicate active name |
| `PATCH /collections/:collectionId`                  | editor | `{ name }`                                               |
| `POST /collections/:collectionId/archive`           | editor | Items stay; the collection is hidden                     |
| `PUT /collections/:collectionId/assets/:assetId`    | editor | Add (idempotent); asset must be in the same project      |
| `DELETE /collections/:collectionId/assets/:assetId` | editor | Remove the membership only (`204`)                       |

Web: collection filter and "Add to collection" in the Library panel; create from the filter bar.

## 7. Tests

| Level           | Tests                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Database        | Collections: composite FKs (cross-project refused), no hard delete, unique active name; schema inventory |
| API integration | Filters; scene reference validation; collection CRUD, isolation, idempotent add; permission matrix rows  |
| Unit            | Picker filtering helpers; brief form body                                                                |

## 8. Implementation plan

| Slice | Content                                                                   |
| ----- | ------------------------------------------------------------------------- |
| P2b-1 | L1 filters, L2 picker, Library paging                                     |
| P2b-2 | L4 scene references (validation + editor) and brief character/environment |
| P2b-3 | L3 characters and environments pages                                      |
| P2b-4 | L5 collections (migration, API, Library UI)                               |

## 9. Risks

- **Brand UI touches the M1 approval protocol**: it only calls the existing endpoints with
  `If-Match`; no new server rules.
- **Scene reference validation is new**: edits that previously stored a rejected or archived
  reference are now refused; stored versions are unaffected.
- **Search uses `ILIKE`** on two columns within one project: fine at current volume; an index can
  follow if needed.

## 10. Deviations and results found during implementation

| Item                          | Planned                                | Done                                                                         | Why                                                                                                                           |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Unique active collection name | Partial unique index                   | Checked in `CollectionsService` (case-insensitive)                           | A partial index is invisible to Prisma and fails the drift check; names only organise the Library, so a rare race is harmless |
| Library paging                | "Show more" per project                | Newest 60 per project with server filters, and a notice to narrow the search | Smaller change; search and filters reach older assets                                                                         |
| Brief character/environment   | `NewContentForm` and master brief form | Master brief form only (variants get it by resync)                           | The master holds the brief; variants copy it                                                                                  |
| Scene references              | Field inside the scene editor          | Separate "References" button with the picker                                 | Avoids a dialog inside a dialog                                                                                               |
| `mutate()`                    | —                                      | Accepts request headers and `DELETE`                                         | `If-Match` on approvals; removing collection members                                                                          |
| E2E                           | Picker, brand page, collections        | **Not written**                                                              | Follow-up with the full stack                                                                                                 |

Verification: lint, typecheck, format, build and unit tests pass; database integration **run**
(301 passed, incl. collections, drift and grants); API integration tests (filters, scene
references, collections, permission matrix) written, **not run** (the API suite needs S3 storage in
the implementation session).

## 11. Revision 2 — P2c: the picker can add to the Library (approved 2026-11-21)

Owner decision of 2026-11-21: **L2 is reversed**. The asset picker keeps choosing existing
Library assets and now also:

- filters by **collection** (the existing `collectionId` filter) and, for multi-select pickers,
  offers **Choose all in {collection}**;
- offers **Add to Library** for reference images: files go through the normal upload endpoint
  (`POST /projects/:id/assets/upload`, same validation, `assetType: reference`, pending review)
  and, when a collection is open, are added to it (`PUT /collections/:id/assets/:assetId`). The new
  assets are selected at once. A failed collection link keeps the upload and says so.

The Library stays the single source of truth: an upload from the picker is an ordinary Library
asset, bound to production only by its ID (L4 unchanged). No API change.

Also (UX review U6): clips in the Library show a frame of the clip as their poster, file types
read "Subtitles (SRT)" instead of `application/x-subrip`, and the project filter adds the slug when
two projects share a name.

## 12. Revision 3 — product photos in the brief (2026-11-21)

Defect reported by the owner: a review video of one keyboard model got a different, random
keyboard in each keyframe, and the clips inherited them. Cause: keyframes only received
character, environment and per-scene references; a product had no place in the brief, so unless
every scene was given a reference by hand, the image model saw only text.

Decision (by recommendation, owner rule of 2026-11-21):

- The brief gets `productAssetIds` (1–4 Library `reference`/`image` assets of the project). The
  content item page and the master page show **Product photos** with the asset picker (upload
  included, P2c); a master change reaches variants by resync as every brief change.
- Image planning reads the item's current brief and sends the photos with **every** scene,
  after the character master and before the environment (role `product`, recorded in
  `asset_inputs`; migration `20261121160000_product_references`). They are part of the scene hash
  and execution key, so keyframes made without them are never reused for scenes that now have
  them; existing keyframes stay until the editor regenerates the scene.
- Prompt `image.v2`: with product references it asks for exactly the referenced product (model,
  shape, colours, layout, markings; the reference wins over the text) and keeps the product's own
  logo instead of forbidding logos. Without product references the text equals `image.v1`; the
  worker records each job's own template id.
- Checks: the brief check reports an unusable photo (`brief.productAssetIds.N`, blocks script
  generation); image estimate/generate refuse it with `422 REFERENCE_INVALID`, and a photo without
  stored bytes with `422 REFERENCE_FILE_MISSING`, before any paid call.
- `AssetInputRole` (contracts) now also lists `sfx`, which render lineage already wrote.

Not changed: storyboard prompts (the LLM is not told about the photos; the image prompt line
makes the reference win), clip generation (clips start from the keyframe).
