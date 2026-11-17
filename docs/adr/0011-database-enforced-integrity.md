# ADR-0011: Database-enforced integrity (composite FKs, CHECKs, triggers)

- Status: **Accepted** (owner approved M1 design review package revision 4, 2026-11-17). Role
  separation (U3) approved. Implemented in M1a (migration `init_m1`, `pnpm db:setup`).
  Production role provisioning is documented only (`docs/DATABASE.md` §8; owner decision).
- Date: 2026-11-17
- Milestone: M1

## Context

Service-layer checks alone do not protect data from direct SQL (operators, scripts, future
workers, bugs). The owner required triggers for approved-version and link immutability, immutable
asset file identity, archive-instead-of-delete, a transactional last-owner rule, and documented
behaviour under direct SQL.

## Decision

1. **Project isolation via composite foreign keys.** Project-scoped tables expose
   `UNIQUE(project_id, id)`, and children reference them through `(project_id, fk)`. A
   cross-project reference is a plain FK violation (`23503`).
2. **CHECK constraints** for local row rules: approval-field consistency, positive version,
   checksum format, derived-asset source, normalized email, session hash length, expiry order.
3. **Triggers** for cross-row and state rules:
   - archive-only deletes (`AC006`);
   - frozen approved versions (`AC001`) and links (`AC002`);
   - forward-only master pointer (`AC003`);
   - approval-sets-master at commit (`AC004`);
   - immutable asset identity (`AC005`) and in-use archive block (`AC008`);
   - **(rev. 3)** no approval while a referenced asset is archived (`AC010`);
   - at least one owner per project at commit (`AC007`);
   - draft-only version inserts (`AC009`).
4. **SQLSTATE contract**: custom class `AC` codes are stable and mapped to API error codes.
   Messages are for operators.
5. **Lock protocol (revision 4)**: one global order, used by the triggers and the service code:

   ```text
   link row → version → parent (character/environment) → asset rows (ascending id)
   member row → project
   ```

   A row trigger runs after its own row is locked, so **a guard may only lock rows that come later
   in the order**. Revision 3 broke this rule, with archive locking versions and the owner check
   locking other member rows. A deterministic lock-boundary harness reproduced the resulting
   cycles (`40P01` in 20/40 runs).

6. **Isolation and materialized conflicts**: application transactions use READ COMMITTED.
   - Under READ COMMITTED a loser waits, re-reads committed data, and fails with an `AC0xx`
     code.
   - For REPEATABLE READ / SERIALIZABLE, a guard that decides from a read cannot lock earlier
     rows without breaking point 5. Instead, the competing operation **writes** the shared,
     later row with a no-op `UPDATE`: approval writes its asset rows, and owner changes write the
     project row.
   - The other transaction then gets `40001` rather than acting on a stale snapshot.

   Races end in `AC0xx` or `40001`, never in an invalid commit. **A `40P01` on a
   protocol-following path is a defect**: tests fail on it, and production logs it at error
   level. Raw SQL written outside the protocol can still deadlock; PostgreSQL then aborts one
   side, and the invariants still hold.

   Three negative controls keep this honest:
   - revision-3 SQL deadlocks;
   - revision-2 SQL breaks the invariant;
   - removing the materializing write breaks the invariant under REPEATABLE READ.

7. **Ownership in Prisma**: CHECKs, functions and triggers live in migration SQL. Prisma does not
   model them, and a drift diff is empty with them applied. CI asserts they exist and are enabled.
8. **Roles** (U3, approved): migrations, seed and test setup run as the owner role
   `acf_migrator`; the API runs as `acf_app` with `SELECT/INSERT/UPDATE/DELETE` grants only.
   Verified: `acf_app` cannot `DISABLE TRIGGER`, `DROP TRIGGER`, `TRUNCATE` or set
   `session_replication_role`.

## Consequences

- Invariants hold for every client, not just the API. Services still pre-check every rule, to
  return precise 4xx errors and keep trigger errors as a backstop.
- Schema changes to guarded tables must review the trigger functions (frozen-column lists).
- Test cleanup uses `TRUNCATE`, which bypasses row triggers by design.
- Approvals sharing an asset serialize on the asset row; each approval and owner change writes
  dead tuples (negligible; autovacuum).
- A concurrency defect (REPEATABLE READ could leave zero owners) was found and fixed during
  design verification. This shows these rules need concurrency tests, not only unit tests.

## Alternatives considered

- **Service-only enforcement**: rejected by the owner; offers no protection from direct SQL.
- **Row-level security policies**: more suited to multi-tenant isolation per database user. The
  MVP API uses a single application role, so the composite FKs and triggers are simpler.
- **Prisma partial indexes** (preview in 7.x): avoided; the one-master-image rule is structural
  (`primary_asset_id`).
- **Fix the revision-3 deadlocks with retries or longer `lock_timeout`/`deadlock_timeout`**:
  rejected. The cycles would remain, and retries would only hide them.
- **Advisory locks taken in triggers** (e.g. `pg_advisory_xact_lock(project)`): rejected. A row
  trigger still runs after its own row lock, so an advisory lock taken there cannot come first in
  the order. Advisory locks are also invisible to raw SQL that does not fire the trigger.
- **SERIALIZABLE for every transaction**: correct, but every write path would need
  serialization-retry handling. A single lock order plus materialized conflicts gives
  deterministic outcomes at READ COMMITTED.
