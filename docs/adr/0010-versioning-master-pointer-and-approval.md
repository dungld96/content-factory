# ADR-0010: Versioning, master pointer and approval concurrency

- Status: **Proposed** (M1 design review package, revision 4). D1 semantics unchanged; U2/U4/U5 approved.
- Date: 2026-11-17
- Milestone: M1

## Context

Characters and environments are reusable brand assets. Approved versions ("masters") must never
be overwritten, version changes must preserve historical references, and approving a version and
updating the current master must be atomic under concurrent requests (owner review 2026-11-17).
D1 defines the master as the latest approved version.

## Decision

1. Versions are numbered per parent (`UNIQUE(parent_id, version)`) and are born as `draft`.
   Drafts are editable (D11). Approval is a one-way `draft → approved` transition. Approved
   versions and their asset links are immutable. Approved versions are never deleted.
2. The master is the **highest-numbered approved version**. The parent stores a denormalized
   `master_version_id`, constrained by a composite FK to a version of the same parent.
3. Approval runs in one READ COMMITTED transaction:
   1. Lock the version (`FOR UPDATE`).
   2. Lock the parent (`FOR NO KEY UPDATE`).
   3. Lock the primary and all linked assets (`FOR NO KEY UPDATE`, ascending id).
   4. Validate: still a draft (`409 ALREADY_APPROVED`), newer than the master
      (`409 STALE_DRAFT`), optional `If-Match`, and every locked asset active
      (`409 ASSET_ARCHIVED`).
   5. Set `approved`.
   6. Move the pointer.
   7. Commit.

   **Lock order (revision 4)**: **version → parent → asset rows (ascending id)**. This is the
   order in which a raw `UPDATE character_versions` acquires locks (the row first, then the
   trigger's locks), so service code and raw SQL agree. Asset archival locks **only** the asset
   row. Revision 3 had the archive trigger also lock the referencing versions, and the service
   take the parent before the version. Both formed deadlock cycles, which a deterministic
   lock-boundary harness reproduced (`40P01` in 20/40 runs).

4. The database enforces the invariants independently of the service:
   - The pointer only moves forward to an approved version and can't be cleared.
   - A deferred constraint trigger rejects any commit in which a version was approved but did
     not become the master.
   - Link changes on approved versions are rejected. The link trigger reads the parent version
     `FOR SHARE`, so it waits for in-flight approvals.
   - **(rev. 3, locking revised in rev. 4)** Approving is rejected (`AC010`) if the primary or
     any linked asset is archived. The check locks the parent, then the assets in id order, and
     writes them with a no-op `UPDATE`. That write conflicts with a concurrent archive (same row)
     and makes REPEATABLE READ archivals fail with `40001` instead of trusting a stale snapshot.
     Archiving is rejected (`AC008`) if any referencing version is approved; it locks nothing but
     its own row. Whichever commits first wins; the other fails (READ COMMITTED: `AC0xx`;
     REPEATABLE READ: `40001`), never with `40P01`. An approved version can never reference an
     archived asset.
5. Rollback is **append-only**: create a new draft `basedOnVersionId` of an older version and
   approve it. It becomes the new highest version and master. Old version IDs remain valid
   references.
6. Approving a draft numbered below the current master is rejected (`409 STALE_DRAFT`;
   decision U2).

## Consequences

- Downstream records (M3 scenes, M4+ generation jobs) reference **version IDs**, never "the
  current master", so history is preserved automatically.
- Approvals for one character serialize. Approvals that **share an asset** also serialize, on
  the asset row (the cost of the materialized conflict). Otherwise approvals don't contend.
- Verified with concurrent PostgreSQL sessions: out-of-order approvals, double approvals and link
  inserts racing an approval all preserve the invariants. **Rev. 3**: so do 16 archive-vs-approval
  races (both orders, primary and linked references, RC and RR, raw SQL and service paths).
  **Rev. 4**: a deterministic matrix of 40 lock-boundary runs gives the exact expected SQLSTATEs
  with zero `40P01`. Negative controls prove the old designs fail: rev. 3 deadlocks, rev. 2 breaks
  the invariant, and dropping the materializing write breaks it under RR
  (`docs/design/m1/evidence/`).

## Alternatives considered

- **No pointer; derive the master by `max(version) WHERE approved`**: simpler, but the owner
  required an atomic pointer update, and the pointer makes "current master" a cheap,
  FK-checked lookup.
- **Freely settable pointer** (choose any approved version as master): conflicts with D1 and
  allows silent rollbacks without a new auditable version.
- **SERIALIZABLE transactions with retries** instead of explicit locks: correct, but adds retry
  plumbing to every write path. Explicit row locks under READ COMMITTED are simpler and were
  verified.
