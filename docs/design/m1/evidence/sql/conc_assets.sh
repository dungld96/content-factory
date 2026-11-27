#!/usr/bin/env bash
# CRITICAL-2 regression: concurrent asset archival vs version approval (timed overlap).
# Each scenario runs on a freshly created database, as the DML-only role acf_app (U3), under
# READ COMMITTED and REPEATABLE READ, for primary and linked references. For EVERY scenario:
#   * both sessions' psql exit codes and PostgreSQL SQLSTATEs are captured and asserted against
#     the expected outcome (first session commits; second gets the expected code/decision);
#   * any 40P01 (deadlock) is a FAILURE, never an acceptable "invariant-preserving" outcome;
#   * the invariant "no approved version references an archived asset" is checked.
# The deterministic lock-boundary matrix (no sleeps) is lock_matrix.mjs; this script keeps the
# coarse timed overlap as a second, independent check.
# Exit code 0 only if every scenario matches.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
M1=$(cd "$HERE/../.." && pwd)
DB=acf_design_spike
PG=(docker exec -i acf-postgres-1 psql -v ON_ERROR_STOP=1 -qtA)
as_owner() { "${PG[@]}" -U acf -d "$DB" "$@"; }
as_app()   { docker exec -i -e PGPASSWORD=acf_app_spike acf-postgres-1 psql -h 127.0.0.1 -U acf_app -d "$DB" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qtA "$@"; }
fail=0

U=00000000-0000-7000-8000-000000000001; P=10000000-0000-7000-8000-000000000001
X=20000000-0000-7000-8000-0000000000aa     # the contested asset
C=30000000-0000-7000-8000-0000000000aa; V=31000000-0000-7000-8000-0000000000aa

reset() {
  "${PG[@]}" -U acf -d acf -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
  cat "$M1/generated-tables.sql" "$M1/triggers.sql" | "${PG[@]}" -U acf -d "$DB" >/dev/null 2>&1
  as_owner >/dev/null 2>&1 <<SQL
DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acf_app') THEN
  CREATE ROLE acf_app LOGIN PASSWORD 'acf_app_spike' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END \$\$;
GRANT CONNECT ON DATABASE $DB TO acf_app;
GRANT USAGE ON SCHEMA public TO acf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acf_app;
INSERT INTO users (id,email,display_name,password_hash,updated_at) VALUES ('$U','o@x.test','O','x',now());
BEGIN;
INSERT INTO projects (id,name,slug,default_language,timezone,created_by_id,updated_at) VALUES ('$P','P','p','vi','UTC','$U',now());
INSERT INTO project_members (project_id,user_id,role,updated_at) VALUES ('$P','$U','owner',now());
COMMIT;
INSERT INTO assets (id,project_id,asset_type,source_type,storage_key,mime_type,size_bytes,checksum_sha256,created_by_id,updated_at)
  VALUES ('$X','$P','reference','upload','k/x','image/png',1,repeat('a',64),'$U',now());
INSERT INTO characters (id,project_id,name,slug,created_by_id,updated_at) VALUES ('$C','$P','C','c','$U',now());
INSERT INTO character_versions (id,project_id,character_id,version,description,primary_asset_id,created_by_id,updated_at)
  VALUES ('$V','$P','$C',1,'v1',$1,'$U',now());
SQL
  if [ "$2" = link ]; then
    as_owner -c "INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES ('$P','$V','$X')" >/dev/null
  fi
}

invariant() {
  as_owner -c "SELECT count(*) FROM character_versions v JOIN assets a ON a.archived_at IS NOT NULL
    AND (a.id = v.primary_asset_id OR a.id IN (SELECT asset_id FROM character_version_assets l WHERE l.character_version_id = v.id))
    WHERE v.status = 'approved'"
}

approve_sql() { # isolation, sleep-before-commit
cat <<SQL
BEGIN ISOLATION LEVEL $1;
UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U' WHERE id='$V';
UPDATE characters SET master_version_id='$V' WHERE id='$C';
SELECT pg_sleep($2);
COMMIT;
SELECT 'committed';
SQL
}
archive_sql() {
cat <<SQL
BEGIN ISOLATION LEVEL $1;
UPDATE assets SET archived_at = now() WHERE id = '$X';
SELECT pg_sleep($2);
COMMIT;
SELECT 'committed';
SQL
}
# Service paths follow the revision-4 lock protocol: version -> parent -> assets (id order);
# archival locks only the asset row. Each prints its decision; a 409 decision commits nothing.
svc_approve_sql() {
cat <<SQL
BEGIN ISOLATION LEVEL $1;
SELECT 1 FROM character_versions WHERE id='$V' FOR UPDATE;
SELECT 1 FROM characters WHERE id='$C' FOR NO KEY UPDATE;
SELECT CASE WHEN bool_or(archived_at IS NOT NULL) THEN 'ASSET_ARCHIVED' ELSE 'ok' END AS d
  FROM (SELECT archived_at FROM assets WHERE id IN (SELECT primary_asset_id FROM character_versions WHERE id='$V'
        UNION SELECT asset_id FROM character_version_assets WHERE character_version_id='$V') ORDER BY id FOR NO KEY UPDATE) s \gset
\echo service decision: :d
SELECT pg_sleep($2);
UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U' WHERE id='$V' AND :'d' = 'ok';
UPDATE characters SET master_version_id='$V' WHERE id='$C' AND :'d' = 'ok';
COMMIT;
SELECT 'committed';
SQL
}
svc_archive_sql() {
cat <<SQL
BEGIN ISOLATION LEVEL $1;
SELECT 1 FROM assets WHERE id='$X' FOR NO KEY UPDATE;
SELECT CASE WHEN EXISTS (SELECT 1 FROM character_versions WHERE status='approved' AND (primary_asset_id='$X'
   OR id IN (SELECT character_version_id FROM character_version_assets WHERE asset_id='$X'))) THEN 'ASSET_IN_USE' ELSE 'ok' END AS d \gset
\echo service decision: :d
SELECT pg_sleep($2);
UPDATE assets SET archived_at = now() WHERE id='$X' AND :'d' = 'ok';
COMMIT;
SELECT 'committed';
SQL
}

# outcome <logfile> <exitcode> -> "commit" | "decision:<X>" | SQLSTATE | "exit<N>"
outcome() {
  local code; code=$(sed -nE 's/^ERROR:  ([0-9A-Z]{5}): .*/\1/p' "$1" | head -1)
  if [ -n "$code" ]; then echo "$code"; return; fi
  if [ "$2" != 0 ]; then echo "exit$2"; return; fi
  local d; d=$(grep -oE 'service decision: [A-Z_a-z]+' "$1" | head -1 | awk '{print $3}')
  if [ -n "$d" ] && [ "$d" != ok ]; then echo "decision:$d"; return; fi
  grep -q '^committed$' "$1" && echo commit || echo "no-commit"
}

run() { # name, refkind, isolation, first-sql-fn, second-sql-fn, expected-second
  reset "$([ "$2" = primary ] && echo "'$X'" || echo NULL)" "$2"
  local L1 L2; L1=$(mktemp); L2=$(mktemp)
  ( "$4" "$3" 2 | as_app > "$L1" 2>&1; echo $? > "$L1.rc" ) &
  sleep 0.6
  ( "$5" "$3" 0 | as_app > "$L2" 2>&1; echo $? > "$L2.rc" ) &
  wait
  local o1 o2 bad verdict=PASS
  o1=$(outcome "$L1" "$(cat "$L1.rc")"); o2=$(outcome "$L2" "$(cat "$L2.rc")"); bad=$(invariant)
  [ "$o1" = commit ] || verdict=FAIL
  [ "$o2" = "$6" ] || verdict=FAIL
  [ "$bad" = 0 ] || verdict=FAIL
  if [ "$o1" = 40P01 ] || [ "$o2" = 40P01 ]; then verdict="FAIL (DEADLOCK 40P01)"; fi
  [ "$verdict" = PASS ] || fail=1
  printf '%-44s %-8s %-16s first=%-8s second=%-22s expected second=%-22s invariant=%s  %s\n' \
    "$1" "$2" "$3" "$o1" "$o2" "$6" "$([ "$bad" = 0 ] && echo ok || echo "BROKEN($bad)")" "$verdict"
  if [ "$verdict" != PASS ]; then sed 's/^/      first : /' "$L1"; sed 's/^/      second: /' "$L2"; fi
  rm -f -- "$L1" "$L2" "$L1.rc" "$L2.rc"
}

for iso in "READ COMMITTED" "REPEATABLE READ"; do
  rr() { [ "$iso" = "READ COMMITTED" ] && echo "$1" || echo 40001; }
  for ref in primary link; do
    run "A1 raw: archive first, then approval"     $ref "$iso" archive_sql     approve_sql     "$(rr AC010)"
    run "A2 raw: approval first, then archive"     $ref "$iso" approve_sql     archive_sql     "$(rr AC008)"
    run "A3 service: approval first, then archive" $ref "$iso" svc_approve_sql svc_archive_sql "$(rr decision:ASSET_IN_USE)"
    run "A4 service: archive first, then approval" $ref "$iso" svc_archive_sql svc_approve_sql "$(rr decision:ASSET_ARCHIVED)"
  done
done

echo "== U3: the runtime role cannot bypass triggers"
reset NULL primary
for stmt in "ALTER TABLE assets DISABLE TRIGGER ALL" "TRUNCATE assets CASCADE" "DROP TRIGGER assets_guard ON assets" "SET session_replication_role = replica"; do
  out=$(echo "$stmt;" | as_app 2>&1 | head -1)
  if echo "$out" | grep -qiE "must be owner|permission denied"; then echo "   PASS denied: $stmt"; else echo "   FAIL allowed: $stmt -> $out"; fail=1; fi
done
"${PG[@]}" -U acf -d acf -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
echo "RESULT: $([ $fail = 0 ] && echo 'all scenarios matched expected SQLSTATEs; no 40P01; invariant held' || echo FAILURES)"
exit $fail
