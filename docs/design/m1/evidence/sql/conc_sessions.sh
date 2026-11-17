#!/usr/bin/env bash
# CRITICAL-1, database level: the store's UPDATE-only set() racing logout's DELETE.
# Both orders, statement-level (the store runs single autocommit statements, READ COMMITTED).
# Invariant: after logout commits, the session row never exists again.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); M1=$(cd "$HERE/../.." && pwd); DB=acf_design_spike
PG=(docker exec -i acf-postgres-1 psql -v ON_ERROR_STOP=1 -qtA -U acf)
q() { "${PG[@]}" -d $DB "$@"; }
fail=0
H="'\\x$(printf 'a%.0s' $(seq 1 64))'::bytea"   # a 32-byte id_hash
U=00000000-0000-7000-8000-000000000001
SET_SQL="UPDATE sessions SET data = '{\"userId\":\"$U\",\"authenticatedAt\":\"x\",\"cookie\":{}}', last_seen_at = now()
         WHERE id_hash = $H AND user_id = '$U' AND expires_at > now() AND absolute_expires_at > now()"

reset() {
  "${PG[@]}" -d acf -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
  cat "$M1/generated-tables.sql" "$M1/triggers.sql" | "${PG[@]}" -d $DB >/dev/null 2>&1
  q -c "INSERT INTO users (id,email,display_name,password_hash,updated_at) VALUES ('$U','o@x.test','O','x',now())" >/dev/null
  q -c "INSERT INTO sessions (id_hash,user_id,data,expires_at,absolute_expires_at) VALUES ($H,'$U','{}',now()+interval '1 day',now()+interval '7 day')" >/dev/null
}
verdict() {
  local n; n=$(q -c "SELECT count(*) FROM sessions WHERE id_hash = $H")
  if [ "$n" = 0 ]; then echo "   PASS row absent after logout"; else echo "   FAIL row present ($n)"; fail=1; fi
}

reset; echo "== S1 logout DELETE in flight (uncommitted) while set() UPDATE arrives"
(echo "BEGIN; DELETE FROM sessions WHERE id_hash = $H; SELECT pg_sleep(2); COMMIT;" | q >/dev/null) &
sleep 0.5
echo "$SET_SQL RETURNING 'set updated a row (BAD)';" | q | sed 's/^/   set(): /'; echo "   set(): returned (0 rows expected)"
wait; verdict

reset; echo "== S2 set() UPDATE in flight (uncommitted) while logout DELETE arrives"
(echo "BEGIN; $SET_SQL; SELECT pg_sleep(2); COMMIT;" | q >/dev/null) &
sleep 0.5
echo "DELETE FROM sessions WHERE id_hash = $H RETURNING 'delete removed the row';" | q | sed 's/^/   destroy(): /'
wait; verdict

reset; echo "== S3 logout committed, then a late set()"
q -c "DELETE FROM sessions WHERE id_hash = $H" >/dev/null
echo "$SET_SQL RETURNING 'set updated a row (BAD)';" | q | sed 's/^/   set(): /'; verdict

"${PG[@]}" -d acf -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
echo "RESULT: $([ $fail = 0 ] && echo 'session row never reappears' || echo FAILURES)"
exit $fail
