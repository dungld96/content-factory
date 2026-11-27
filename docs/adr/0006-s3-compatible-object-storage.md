# ADR-0006: S3-compatible object storage

- Status: Accepted (amended 2026-11-18, M4a)
- Date: 2026-11-17
- Milestone: M0 (decision); implementation in M4

## Context

Generated images, clips, audio, subtitles and renders are large binaries that must be immutable,
private by default and portable across hosting providers.

## Decision

- Binaries live in S3-compatible object storage; PostgreSQL stores metadata, checksum, dimensions,
  duration and lineage only.
- Access through an internal storage abstraction using the S3 API, so Cloudflare R2, AWS S3 or
  MinIO can be swapped by configuration.
- Buckets are private; previews/downloads use short-lived signed URLs; uploads use presigned
  uploads with MIME type and size validation.
- Object keys are content-addressed or versioned; source assets are never overwritten.
- Local development will add MinIO to `infra/compose` when the storage module lands (M4). It is not
  part of M0, whose acceptance only requires PostgreSQL and Redis.

## Consequences

- Egress/storage costs are tracked as a cost category (`docs/COST_STRATEGY.md`).
- The MinIO image/version and the S3 SDK version must be verified at M4 time.

## Amendment (2026-11-18, M4a — M4 design package G3, G4)

- **SeaweedFS replaces MinIO.** `minio/minio` is no longer published on Docker Hub (HTTP 404 on
  2026-11-18). Local development, CI and staging run `chrislusf/seaweedfs:4.54` (Apache-2.0),
  started by `infra/seaweedfs/start.sh`, which writes two S3 identities from the environment: a
  storage admin key (bucket setup only) and the application key (read, write, list). The S3 SDK is
  `@aws-sdk/client-s3@3.1171.0`; any S3-compatible service can replace SeaweedFS by
  configuration. Fallback if SeaweedFS misbehaves: RustFS.
- **Verified behaviour** (`packages/storage/test/s3-compat.integration.test.ts`): checksummed puts
  (`x-amz-checksum-sha256`, mismatch rejected), conditional writes (`If-None-Match: *` → `412`),
  head, ranged get, list, 404s. SeaweedFS's simple identities cannot deny delete to a key that
  can write, so immutability is enforced by the application: the `ObjectStore` interface has no
  delete, and every write is conditional, so an existing object is never overwritten.
- **Bytes go through the API in M4** (decision G4): raw-body uploads (≤ 25 MB images) and
  authenticated streaming reads (`GET /assets/:assetId/content`). Storage is reachable only on
  the internal network; browsers never receive storage URLs. Presigned uploads/short-lived signed
  URLs are deferred to M5, where video sizes make API streaming expensive.
- Keys are `projects/{projectId}/assets/{assetId}/{sha256}.{ext}`. A failed database insert after
  a successful write leaves a private orphan object; a sweep is planned for M7.
