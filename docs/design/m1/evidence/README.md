# M1 design verification evidence

Scripts used on 2026-11-17 to validate the design against the real stack before any M1 code was
written. They ran against a throwaway database (`acf_design_spike`) on the local Docker
PostgreSQL 17.12, and an isolated scratch app (NestJS 12.3.2 / Express 5.3.0 /
express-session 1.19.0 / csrf-csrf 4.1.0 / Next.js 16.4.6). They are **not** part of the
workspace build and are excluded from lint and format. In M1 they become proper Vitest
integration tests.

| File | What it proves | Result |
|---|---|---|
| `sql/test_direct_sql.sql` | Every constraint and trigger rejects the forbidden operation **via direct SQL**, with the expected SQLSTATE | 38/38 pass |
| `sql/conc.sh` | Concurrent sessions: owner demotion race, link insert vs in-flight approval, out-of-order approvals, double approval, REPEATABLE READ hazard | All safe after one fix (see the package, §6.4) |
| `sql/conc2.sh` | Service-layer last-owner algorithm under READ COMMITTED and REPEATABLE READ | RC: clean 409. RR: trigger raises 40001 |
| `sql/errtest.ts` | How Prisma 7 + adapter-pg surfaces custom SQLSTATEs, unique/FK errors, deferred-trigger errors; `uuid(7)`; service approval algorithm through Prisma | Mappable (see the package, §8.3) |
| `session/store.ts`, `session/main.ts` | Hashed-ID express-session store on the NestJS 12 Express adapter, with csrf-csrf | Runs on Express 5.3.0 |
| `session/test.mjs` | Login/logout/expiry/fixation/concurrency/revoke-all/CSRF **through the Next.js rewrite proxy** | 25/25 pass |
| `session/next.config.mjs` | The rewrite used for the same-origin topology | Set-Cookie forwarded |

To reproduce the SQL checks (requires `pnpm infra:up`):

```bash
docker exec -i acf-postgres-1 psql -U acf -d acf -c "CREATE DATABASE acf_design_spike"
```

```bash
cat docs/design/m1/generated-tables.sql docs/design/m1/triggers.sql | docker exec -i acf-postgres-1 psql -v ON_ERROR_STOP=1 -U acf -d acf_design_spike
```

```bash
docker exec -i acf-postgres-1 psql -U acf -d acf_design_spike < docs/design/m1/evidence/sql/test_direct_sql.sql
```
