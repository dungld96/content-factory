#!/usr/bin/env bash
# Reproducible session evidence: fresh DB from the committed design SQL, API as acf_app (U3),
# browser traffic through the Next.js rewrite. Usage: run.sh <path-to-docs/design/m1>
set -u
M1=$1; HERE=$(cd "$(dirname "$0")" && pwd); DB=acf_design_spike
PG=(docker exec -i acf-postgres-1 psql -v ON_ERROR_STOP=1 -qtA -U acf)
"${PG[@]}" -d acf -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
cat "$M1/generated-tables.sql" "$M1/triggers.sql" | "${PG[@]}" -d $DB >/dev/null 2>&1 || { echo "schema apply failed"; exit 1; }
"${PG[@]}" -d $DB >/dev/null <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acf_app') THEN
  CREATE ROLE acf_app LOGIN PASSWORD 'acf_app_spike' NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;
GRANT CONNECT ON DATABASE acf_design_spike TO acf_app;
GRANT USAGE ON SCHEMA public TO acf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acf_app;
INSERT INTO users (id,email,display_name,password_hash,updated_at) VALUES
  ('00000000-0000-7000-8000-0000000000a1','owner@example.test','Owner','x',now()),
  ('00000000-0000-7000-8000-0000000000a2','editor@example.test','Editor','x',now());
SQL
cd "$HERE"
pkill -f "$HERE/dist/main.js" 2>/dev/null; pkill -f "next dev --port 3100" 2>/dev/null; sleep 1
DATABASE_URL="postgresql://acf_app:acf_app_spike@localhost:5432/$DB" TOUCH_THROTTLE_MS=0 node "$HERE/dist/main.js" > "$HERE/api.log" 2>&1 &
API_PID=$!
(cd "$HERE/web" && exec ../node_modules/.bin/next dev --port 3100 > "$HERE/web.log" 2>&1) &
WEB_PID=$!
for i in $(seq 1 60); do curl -sf -o /dev/null localhost:3100/api/v1/debug/request && break; sleep 1; done
head -1 "$HERE/api.log"
INSPECT_DATABASE_URL="postgresql://acf:acf_local_dev_only@localhost:5432/$DB" node "$HERE/test.mjs"; rc=$?
kill $API_PID 2>/dev/null; pkill -P $WEB_PID 2>/dev/null; kill $WEB_PID 2>/dev/null; pkill -f "next dev --port 3100" 2>/dev/null
"${PG[@]}" -d acf -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
exit $rc
