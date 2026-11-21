#!/usr/bin/env bash
# One-command reproduction of all M1 design evidence.
#   Prerequisite: `pnpm infra:up` (container acf-postgres-1 running), Node 22, pnpm 10.
#   Usage: bash docs/design/m1/evidence/run-all.sh [--negative-controls]
# Every suite builds its own throwaway database from the committed generated-tables.sql +
# triggers.sql. The session spike is installed into a temp directory OUTSIDE the workspace.
set -u
EVID=$(cd "$(dirname "$0")" && pwd); M1=$(cd "$EVID/.." && pwd)
WORK=${ACF_EVIDENCE_WORKDIR:-${TMPDIR:-/tmp}/acf-m1-evidence}
NEG=false; [ "${1:-}" = "--negative-controls" ] && NEG=true
mkdir -p "$WORK/logs"
PG=(docker exec -i acf-postgres-1 psql -v ON_ERROR_STOP=1 -qtA -U acf)
declare -a SUMMARY; overall=0
record() { SUMMARY+=("$(printf '%-58s %s' "$1" "$2")"); }
expect_pass() { if [ "$2" = 0 ]; then record "$1" PASS; else record "$1" "FAIL (see $WORK/logs)"; overall=1; fi; }
expect_fail() { if [ "$2" != 0 ]; then record "$1" "PASS (control failed as expected)"; else record "$1" "FAIL (control did not detect the defect)"; overall=1; fi; }

docker exec acf-postgres-1 pg_isready -q || { echo "PostgreSQL container not running: run 'pnpm infra:up'"; exit 2; }

fresh_db() {
  "${PG[@]}" -d acf -c "DROP DATABASE IF EXISTS acf_design_spike" -c "CREATE DATABASE acf_design_spike" >/dev/null 2>&1
  cat "${1:-$M1/generated-tables.sql}" "${2:-$M1/triggers.sql}" | "${PG[@]}" -d acf_design_spike >/dev/null
}

# ---- 1. direct-SQL constraint/trigger suite -------------------------------------------------
fresh_db
docker exec -i acf-postgres-1 psql -U acf -d acf_design_spike -P pager=off < "$EVID/sql/test_direct_sql.sql" > "$WORK/logs/direct_sql.log" 2>&1
line=$(grep -E '^ +[0-9]+ \| +[0-9]+$' "$WORK/logs/direct_sql.log" | tail -1)
passed=$(echo "$line" | awk -F'|' '{gsub(/ /,"",$1); print $1}'); failed=$(echo "$line" | awk -F'|' '{gsub(/ /,"",$2); print $2}')
[ -n "$passed" ] && [ "$failed" = 0 ]; expect_pass "direct SQL suite ($passed checks)" $?

# ---- 2. concurrency suites (conc.sh/conc2.sh reuse the fixtures left by the direct suite) --
(cd "$EVID/sql" && bash conc.sh) > "$WORK/logs/conc.log" 2>&1
grep -q "owners now: 1" "$WORK/logs/conc.log" && grep -q "links on v3: 0" "$WORK/logs/conc.log" \
  && grep -q "master now: v5; v4 status: draft" "$WORK/logs/conc.log" && [ "$(grep -c 'owners now: 1' "$WORK/logs/conc.log")" = 2 ]
expect_pass "concurrency: owners / links / master pointer (C1-C5)" $?
! grep -q "deadlock detected" "$WORK/logs/conc.log"; expect_pass "concurrency C1-C5: no 40P01 (deadlock) in any session" $?
(cd "$EVID/sql" && bash conc2.sh) > "$WORK/logs/conc2.log" 2>&1
expect_pass "concurrency: service last-owner algorithm RC/RR (C6, SQLSTATEs)" $?
bash "$EVID/sql/conc_assets.sh" > "$WORK/logs/conc_assets.log" 2>&1
expect_pass "archive vs approval, timed overlap (16, SQLSTATEs, U3 role)" $?
bash "$EVID/sql/conc_sessions.sh" > "$WORK/logs/conc_sessions.log" 2>&1
expect_pass "CRITICAL-1 SQL: set() UPDATE vs logout DELETE ordering" $?

# ---- 3. session spike (Prisma 7 store, NestJS 12, Next.js proxy, acf_app role) --------------
SESS="$WORK/session"
rm -rf -- "$SESS"; mkdir -p "$SESS"; cp -r "$EVID/session/." "$SESS/"
mkdir -p "$SESS/prisma" && cp "$M1/schema.prisma" "$SESS/prisma/schema.prisma"
( cd "$SESS" && pnpm install --frozen-lockfile --silent --config.confirmModulesPurge=false \
    && npx prisma generate >/dev/null && npx tsc -p tsconfig.json \
    && ln -sfn ../node_modules web/node_modules ) > "$WORK/logs/session_build.log" 2>&1
expect_pass "session spike build (pinned deps, prisma generate, tsc)" $?
bash "$SESS/run.sh" "$M1" > "$WORK/logs/session.log" 2>&1; rc=$?
expect_pass "session suite: $(grep -Eo '[0-9]+/[0-9]+ passed' "$WORK/logs/session.log" | tail -1)" $rc

# ---- 3b. deterministic lock-boundary matrix (pg_blocking_pids barriers; 40P01 = failure) -----
cp "$EVID/sql/lock_matrix.mjs" "$SESS/lock_matrix.mjs"
(cd "$SESS" && node lock_matrix.mjs "$M1/generated-tables.sql" "$M1/triggers.sql" expect-pass) > "$WORK/logs/lock_matrix.log" 2>&1
expect_pass "lock matrix: $(grep -Eo 'scenarios: [0-9]+, deadlocks \(40P01\): [0-9]+' "$WORK/logs/lock_matrix.log" | tail -1)" $?

# ---- 4. Prisma drift: triggers/CHECKs are invisible to Prisma (empty diff) -----------------
fresh_db
cat > "$SESS/prisma.drift.config.ts" <<EOF
import { defineConfig } from 'prisma/config';
export default defineConfig({ schema: '$M1/schema.prisma',
  datasource: { url: 'postgresql://acf:acf_local_dev_only@localhost:5432/acf_design_spike' } });
EOF
(cd "$SESS" && npx prisma migrate diff --config prisma.drift.config.ts --from-config-datasource --to-schema "$M1/schema.prisma" --script) > "$WORK/logs/drift.log" 2>&1
grep -q "This is an empty migration" "$WORK/logs/drift.log"; expect_pass "Prisma drift with triggers applied is empty" $?

# ---- 5. negative controls (optional): reverted designs MUST fail ------------------------------
if $NEG; then
  # 5a. Revision-4 RR mechanism removed: approval only LOCKS the asset rows (no no-op write).
  #     A later archive under REPEATABLE READ then trusts a stale snapshot -> the invariant MUST
  #     break (proves the materialized-conflict write is required).
  NC="$WORK/negctl-sql"; rm -rf -- "$NC"; mkdir -p "$NC/evidence/sql"
  cp "$M1/generated-tables.sql" "$NC/"
  python3 - "$M1/triggers.sql" "$NC/triggers.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
old = "  FOR r IN UPDATE assets SET archived_at = archived_at WHERE id = ANY (ids) RETURNING id, archived_at LOOP"
assert old in s, "rev-4 materializing write not found"
s = s.replace(old, "  FOR r IN SELECT id, archived_at FROM assets WHERE id = ANY (ids) LOOP  -- NEGATIVE CONTROL: lock only")
open(sys.argv[2], "w").write(s)
PY
  python3 - "$EVID/sql/conc_assets.sh" "$NC/evidence/sql/conc_assets.sh" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = s.index('for iso in "READ COMMITTED"'); b = s.index('echo "== U3')
open(sys.argv[2], "w").write(s[:a] + 'run "NEGATIVE CONTROL A2" primary "REPEATABLE READ" approve_sql archive_sql 40001\n' + s[b:])
PY
  bash "$NC/evidence/sql/conc_assets.sh" > "$WORK/logs/negctl_sql.log" 2>&1
  if grep -q "invariant=BROKEN" "$WORK/logs/negctl_sql.log"; then rc=1; else rc=0; fi
  expect_fail "neg. control: approval w/o materializing write (RR)" $rc

  # 5b. CRITICAL-2: approval without the asset check at all
  python3 - "$M1/triggers.sql" "$WORK/triggers_no_asset_check.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
old = """    PERFORM acf_assert_version_assets_active(TG_ARGV[0], TG_ARGV[1], NEW.id, NEW.primary_asset_id,
                                             TG_ARGV[2], (to_jsonb(NEW) ->> TG_ARGV[3])::uuid);
"""
assert old in s, "approval asset-check call not found"
open(sys.argv[2], "w").write(s.replace(old, "    NULL; -- NEGATIVE CONTROL\n"))
PY
  fresh_db "$M1/generated-tables.sql" "$WORK/triggers_no_asset_check.sql"
  docker exec -i acf-postgres-1 psql -U acf -d acf_design_spike -P pager=off < "$EVID/sql/test_direct_sql.sql" > "$WORK/logs/negctl_direct.log" 2>&1
  # The control "fails" (detects the defect) when the suite reports a non-zero failure count.
  if grep -qE '^ +[0-9]+ \| +0$' "$WORK/logs/negctl_direct.log"; then rc=0; else rc=1; fi
  expect_fail "neg. control: approval without asset check (direct SQL)" $rc

  # 5d. revision-3 lock protocol (archive locks versions; owner check locks member rows):
  #     the deterministic matrix MUST observe 40P01, proving the lock cycles were real.
  REPO=$(cd "$M1/../../.." && pwd)
  git -C "$REPO" show 372d976:docs/design/m1/triggers.sql > "$WORK/triggers_rev3.sql"
  (cd "$SESS" && node lock_matrix.mjs "$M1/generated-tables.sql" "$WORK/triggers_rev3.sql" expect-deadlock) > "$WORK/logs/negctl_matrix_rev3.log" 2>&1
  if [ $? = 0 ]; then rc=1; else rc=0; fi
  expect_fail "neg. control: rev-3 lock protocol deadlocks ($(grep -Eo 'deadlocks \(40P01\): [0-9]+' "$WORK/logs/negctl_matrix_rev3.log" | tail -1))" $rc
  # 5e. revision-2 triggers (no approval-time asset check): the matrix MUST see invariant violations.
  git -C "$REPO" show c5b9105:docs/design/m1/triggers.sql > "$WORK/triggers_rev2.sql"
  (cd "$SESS" && node lock_matrix.mjs "$M1/generated-tables.sql" "$WORK/triggers_rev2.sql" expect-violation) > "$WORK/logs/negctl_matrix_rev2.log" 2>&1
  if [ $? = 0 ]; then rc=1; else rc=0; fi
  expect_fail "neg. control: rev-2 triggers break invariant ($(grep -Eo 'invariant violations: [0-9]+' "$WORK/logs/negctl_matrix_rev2.log" | tail -1))" $rc

  # 5c. CRITICAL-1: set() as upsert (revision-2 store)
  NS="$WORK/negctl-session"; rm -rf -- "$NS"; cp -r "$SESS" "$NS"
  python3 - "$NS/src/prisma-session-store.ts" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = s.index("    this.prisma.$executeRaw`\n        UPDATE sessions\n           SET data = ")
b = s.index("      .then((count) => {\n        this.options.onEvent?.({ type: 'set'")
s = s[:a] + """    this.prisma.$executeRaw`
        INSERT INTO sessions (id_hash, user_id, data, expires_at, absolute_expires_at)
        VALUES (${hashSessionId(sid)}, ${payload.userId}::uuid, ${JSON.stringify(payload)}::jsonb,
                ${this.idleExpiry(sess, now)}::timestamptz, ${new Date(now.getTime() + this.options.absoluteTtlMs)}::timestamptz)
        ON CONFLICT (id_hash) DO UPDATE SET data = EXCLUDED.data`
""" + s[b:]
open(p, "w").write(s)
PY
  (cd "$NS" && rm -rf dist && npx tsc -p tsconfig.json) >> "$WORK/logs/negctl_session.log" 2>&1
  bash "$NS/run.sh" "$M1" >> "$WORK/logs/negctl_session.log" 2>&1
  expect_fail "neg. control: set() as upsert (session resurrection)" $?
fi

"${PG[@]}" -d acf -c "DROP DATABASE IF EXISTS acf_design_spike" >/dev/null 2>&1
echo; echo "M1 design evidence — $(date -u +%Y-%m-%dT%H:%M:%SZ) — logs: $WORK/logs"
printf '%s\n' "${SUMMARY[@]}"
echo "OVERALL: $([ $overall = 0 ] && echo PASS || echo FAIL)"
exit $overall
