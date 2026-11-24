# Architecture Decision Records

Material architecture decisions are recorded here (see `CLAUDE.md` §10). One decision per file,
numbered sequentially. Never rewrite an accepted ADR — supersede it with a new one.

| ADR                                                     | Title                                            | Status                                   |
| ------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| [0001](0001-monorepo-modular-architecture.md)           | Monorepo with modular architecture               | Accepted                                 |
| [0002](0002-postgresql-source-of-truth.md)              | PostgreSQL as the source of truth                | Accepted                                 |
| [0003](0003-bullmq-background-execution.md)             | BullMQ/Redis for background execution            | Accepted                                 |
| [0004](0004-capability-specific-provider-adapters.md)   | Capability-specific provider adapters            | Accepted                                 |
| [0005](0005-human-approval-gates.md)                    | Human approval gates                             | Accepted                                 |
| [0006](0006-s3-compatible-object-storage.md)            | S3-compatible object storage                     | Accepted (amended M4a: SeaweedFS)        |
| [0007](0007-toolchain-and-module-system.md)             | Toolchain baseline and ESM module system         | Accepted (M0) — review requested         |
| [0008](0008-validation-contracts-and-error-envelope.md) | Zod contracts, env validation and error envelope | Accepted (M0) — review requested         |
| [0009](0009-authentication-strategy.md) | Authentication strategy (incl. D2 session store) | Accepted (D2 approved with M1 package rev. 4) |
| [0010](0010-versioning-master-pointer-and-approval.md) | Versioning, master pointer and approval concurrency | Accepted (M1 package, rev. 4) |
| [0011](0011-database-enforced-integrity.md) | Database-enforced integrity | Accepted (M1 package, rev. 4) |
| [0012](0012-ai-registry-usage-ledger-and-money.md) | AI registry, usage ledger and money precision | Accepted (M2 package, rev. 1) |
| [0013](0013-generation-jobs-queue-and-worker.md) | Generation jobs, queue and worker process | Accepted (M3 package, rev. 1) |
| [0014](0014-single-vm-staging-deployment.md) | Single-VM staging deployment on Google Cloud | Accepted (owner, option A); cloud parts superseded by 0021 |
| [0015](0015-content-masters-and-format-registries.md) | Content masters, variants and format/platform registries | Accepted (M3.5 review, R0) |
| [0016](0016-scene-image-generation-and-keyframes.md) | Scene image generation, keyframes and the first image provider | Accepted (M4 package, rev. 1) |
| [0017](0017-async-provider-jobs.md) | Asynchronous provider jobs (video) and text-to-speech | Accepted (M5 package, rev. 1) |
| [0018](0018-local-rendering-and-export.md) | Local FFmpeg rendering, automated QC and render approval (gate 5) | Accepted (M6 package, rev. 1) |
| [0019](0019-budgets-reservations-and-circuit-breakers.md) | Budgets with reservations, provider circuit breakers, resume and redaction | Accepted (M7 package, rev. 1) |
| [0020](0020-backup-and-restore.md) | Backup and restore of database and object storage | Accepted (M8 package, rev. 1) |
| [0021](0021-ubuntu-vps-staging-deployment.md) | Staging on a generic Ubuntu VPS; off-server backups with rclone | Accepted (owner, 2026-11-20) |
| [0022](0022-live-job-events-sse.md) | Live job events over Server-Sent Events, read from PostgreSQL | Accepted (owner R-D5, 2026-11-23) |

## Template

```md
# ADR-NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Milestone: Mx

## Context

## Decision

## Consequences

## Alternatives considered
```
