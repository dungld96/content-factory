# ADR-0011: Database-enforced integrity (composite FKs, CHECKs, triggers)

- Status: **Proposed** (part of the M1 design review package)
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
   - at least one owner per project at commit (`AC007`);
   - draft-only version inserts (`AC009`).
4. **SQLSTATE contract**: custom class `AC` codes are stable and mapped to API error codes.
   Messages are for operators.
5. **Isolation**: application transactions use READ COMMITTED with explicit row locks. Triggers
   take locks that make races fail loudly (`40001`/`40P01`/`AC007`) at any isolation level.
6. **Ownership in Prisma**: CHECKs, functions and triggers live in migration SQL. Prisma does not
   model them, and a drift diff is empty with them applied. CI asserts they exist and are enabled.
7. **Roles** (pending decision U3): migrations run as the owner role; the API runs as a DML-only
   role that cannot disable triggers or truncate.

## Consequences

- Invariants hold for every client, not just the API. Services still pre-check every rule, to
  return precise 4xx errors and keep trigger errors as a backstop.
- Schema changes to guarded tables must review the trigger functions (frozen-column lists).
- Test cleanup uses `TRUNCATE`, which bypasses row triggers by design.
- A concurrency defect (REPEATABLE READ could leave zero owners) was found and fixed during
  design verification. This shows these rules need concurrency tests, not only unit tests.

## Alternatives considered

- **Service-only enforcement**: rejected by the owner; offers no protection from direct SQL.
- **Row-level security policies**: more suited to multi-tenant isolation per database user. The
  MVP API uses a single application role, so the composite FKs and triggers are simpler.
- **Prisma partial indexes** (preview in 7.x): avoided; the one-master-image rule is structural
  (`primary_asset_id`).
