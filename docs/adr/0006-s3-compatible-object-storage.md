# ADR-0006: S3-compatible object storage

- Status: Accepted
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
