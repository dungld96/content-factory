# ADR-0020: Backup and restore of database and object storage

- Status: Accepted (M8 design package revision 1, approved 2026-11-20; implemented in M8a)
- Date: 2026-11-20
- Milestone: M8

## Context

Production state lives in two places: PostgreSQL (source of truth, ADR-0002) and the S3-compatible
bucket holding every asset's bytes (ADR-0006). Until M8 the only backup was a manual `pg_dump`
plus VM disk snapshots; object storage had no export and no restore had ever been tested. A
backup that has never been restored is not a backup.

## Decision

1. **One backup = database dump + object export + metadata**, in one directory
   (`infra/deploy/backups/<UTC timestamp>/`):
   - `database.dump`: `pg_dump --format=custom` run inside the PostgreSQL container (the server's
     own client version), including `_prisma_migrations`, triggers and functions;
   - `storage/objects/<key>` and `storage/objects.json` (key, size, SHA-256, content type), written
     by the storage CLI (`apps/api/dist/cli/storage-cli.js export`), which streams and hashes each
     object;
   - `backup.json`: time, git commit, approximate row counts.
2. **Online backups.** Objects are write-once and content-addressed, so exporting while the
   application runs is safe: an object written after the export started is simply not included,
   and its database row either is not in the dump or refers to a key the next backup will hold.
3. **Restore only onto an empty stack**, in a fixed order: roles and grants (`db-setup bootstrap`),
   `pg_restore --exit-on-error`, grants again, bucket, object import (each file checked against the
   manifest before upload; the server checks the SHA-256 again; write-once, so re-running is
   harmless), then `verify --deep`: every manifest object and every `assets` row present in the
   bucket with its recorded size and checksum. A non-empty database is refused.
4. **Proven by drills**: an integration test runs export → import into an empty bucket → deep
   verify (plus tampered-file and unsafe-key refusals); `scripts/backup-drill.sh` runs the full
   database + objects round trip into a scratch database and bucket and compares every table's
   exact row count (record: `docs/design/m8/restore-drill.md`).
5. **Retention and placement**: the last 7 backups stay on the VM; copying off the VM is the
   operator's documented step (their bucket); secrets (`.env.production`) are never in a backup.

## Consequences

- Restoring needs fresh volumes, i.e. a deliberate operator action; there is no partial or
  point-in-time restore (a backup is a whole-system snapshot; data after it is lost).
- The VM needs disk for one more copy of the bucket per backup (objects are not deduplicated
  across backups); 7 backups of a small editorial workload are expected to stay within a few GB.
- The backup tool runs as the caller's uid so files under `backups/` belong to the operator.

## Alternatives considered

- **VM disk snapshots only**: cheap and whole-system, but cannot be restored elsewhere selectively,
  are tied to one cloud, and say nothing about consistency between database and bucket.
- **SeaweedFS volume-level backup (`weed backup`)**: storage-specific and does not check the
  database against the objects; the S3-level export works with any S3-compatible server.
- **Continuous WAL archiving (point-in-time recovery)**: more operations than one VM warrants now;
  a candidate when the workload grows.
