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
| [0006](0006-s3-compatible-object-storage.md)            | S3-compatible object storage                     | Accepted                                 |
| [0007](0007-toolchain-and-module-system.md)             | Toolchain baseline and ESM module system         | Accepted (M0) — review requested         |
| [0008](0008-validation-contracts-and-error-envelope.md) | Zod contracts, env validation and error envelope | Accepted (M0) — review requested         |
| [0009](0009-authentication-strategy.md) | Authentication strategy | Accepted (library selection pending M1 design approval) |

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
