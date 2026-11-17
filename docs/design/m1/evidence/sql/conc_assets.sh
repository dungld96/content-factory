#!/usr/bin/env bash
# CRITICAL-2 regression: concurrent asset archival vs version approval.
# Each scenario runs on a freshly created database, as the DML-only role acf_app (U3), under
# READ COMMITTED and REPEATABLE READ. After every scenario the invariant is checked:
#   no approved version may reference (primary or link) an archived asset.
# Exit code 0 only if every scenario preserves the invariant.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
M1=$(cd "$HERE/../.." && pwd)
DB=acf_design_spike
PG=(docker exec -i acf-postgres-1 psql -v ON_ERROR_STOP=1 -qtA)
as_owner() { "${PG[@]}" -U acf -d "$DB" "$@"; }
as_app()   { docker exec -i -e PGPASSWORD=acf_app_spike acf-postgres-1 psql -h 127.0.0.1 -U acf_app -d "$DB" -v ON_ERROR_STOP=1 -qtA "$@"; }
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
SELECT 'approve committed';
SQL
}
archive_sql() {
cat <<SQL
BEGIN ISOLATION LEVEL $1;
UPDATE assets SET archived_at = now() WHERE id = '$X';
SELECT pg_sleep($2);
COMMIT;
SELECT 'archive committed';
SQL
}
# Service paths use the documented lock order (version before asset) and pre-check for 409s.
svc_approve_sql() {
cat <<SQL
BEGIN ISOLATION LEVEL $1;
SELECT 1 FROM characters WHERE id='$C' FOR NO KEY UPDATE;
SELECT 1 FROM character_versions WHERE id='$V' FOR UPDATE;
SELECT CASE WHEN bool_or(archived_at IS NOT NULL) THEN 'ASSET_ARCHIVED' ELSE 'ok' END AS d
  FROM (SELECT archived_at FROM assets WHERE id IN (SELECT primary_asset_id FROM character_versions WHERE id='$V'
        UNION SELECT asset_id FROM character_version_assets WHERE character_version_id='$V') ORDER BY id FOR SHARE) s \gset
\echo service decision: :d
SELECT pg_sleep($2);
UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U' WHERE id='$V' AND :'d' = 'ok';
UPDATE characters SET master_version_id='$V' WHERE id='$C' AND :'d' = 'ok';
COMMIT;
SQL
}
svc_archive_sql() {
cat <<SQL
BEGIN ISOLATION LEVEL $1;
SELECT 1 FROM character_versions WHERE primary_asset_id='$X'
   OR id IN (SELECT character_version_id FROM character_version_assets WHERE asset_id='$X') ORDER BY id FOR SHARE;
SELECT 1 FROM assets WHERE id='$X' FOR NO KEY UPDATE;
SELECT CASE WHEN EXISTS (SELECT 1 FROM character_versions WHERE status='approved' AND (primary_asset_id='$X'
   OR id IN (SELECT character_version_id FROM character_version_assets WHERE asset_id='$X'))) THEN 'ASSET_IN_USE' ELSE 'ok' END AS d \gset
\echo service decision: :d
SELECT pg_sleep($2);
UPDATE assets SET archived_at = now() WHERE id='$X' AND :'d' = 'ok';
COMMIT;
SQL
}

run() { # name, refkind, isolation, first-sql-fn, second-sql-fn
  reset "$([ "$2" = primary ] && echo "'$X'" || echo NULL)" "$2"
  echo "== $1 [$2 ref, $3]"
  ("$4" "$3" 2 | as_app 2>&1 | grep -vE '^$|CONTEXT|PL/pgSQL|SQL statement' | sed 's/^/   first : /') &
  sleep 0.6
  ("$5" "$3" 0 | as_app 2>&1 | grep -vE '^$|CONTEXT|PL/pgSQL|SQL statement' | sed 's/^/   second: /') &
  wait
  local bad; bad=$(invariant)
  if [ "$bad" = 0 ]; then echo "   invariant OK (approved versions with archived assets: 0)"; else echo "   INVARIANT VIOLATED ($bad)"; fail=1; fi
}

for iso in "READ COMMITTED" "REPEATABLE READ"; do
  for ref in primary link; do
    run "A1 raw: archive first, then approval"   $ref "$iso" archive_sql approve_sql
    run "A2 raw: approval first, then archive"   $ref "$iso" approve_sql archive_sql
    run "A3 service: approval first, then archive" $ref "$iso" svc_approve_sql svc_archive_sql
    run "A4 service: archive first, then approval" $ref "$iso" svc_archive_sql svc_approve_sql
  done
done

echo "== U3: the runtime role cannot bypass triggers"
reset NULL primary
for stmt in "ALTER TABLE assets DISABLE TRIGGER ALL" "TRUNCATE assets CASCADE" "DROP TRIGGER assets_guard ON assets" "SET session_replication_role = replica"; do
  out=$(echo "$stmt;" | as_app 2>&1 | head -1)
  if echo "$out" | grep -qiE "must be owner|permission denied"; then echo "   PASS denied: $stmt"; else echo "   FAIL allowed: $stmt -> $out"; fail=1; fi
done
"${PG[@]}" -U acf -d acf -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
echo "RESULT: $([ $fail = 0 ] && echo 'all scenarios preserved the invariant' || echo FAILURES)"
exit $fail
