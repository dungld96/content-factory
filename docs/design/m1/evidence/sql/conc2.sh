#!/usr/bin/env bash
# C6: service-layer last-owner algorithm (revision-4 lock order: member row -> project row -> count)
# under READ COMMITTED and REPEATABLE READ. Requires the fixtures left by test_direct_sql.sql.
# Asserts each session's outcome/SQLSTATE; any 40P01 is a failure.
DB=acf_design_spike
q() { docker exec -i acf-postgres-1 psql -U acf -d $DB -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qtA "$@"; }
P1=10000000-0000-7000-8000-000000000001; U1=00000000-0000-7000-8000-000000000001; U2=00000000-0000-7000-8000-000000000002
fail=0
svc() { # isolation, user, sleep
cat <<SQL
BEGIN ISOLATION LEVEL $1;
UPDATE project_members SET role='editor' WHERE project_id='$P1' AND user_id='$2';
UPDATE projects SET updated_at = updated_at WHERE id='$P1';
SELECT CASE WHEN count(*) = 0 THEN 'LAST_OWNER' ELSE 'ok' END AS d FROM project_members WHERE project_id='$P1' AND role='owner' \gset
\echo service decision: :d
SELECT pg_sleep($3);
\if :{?d}
\endif
SELECT CASE WHEN :'d' = 'ok' THEN 'commit' ELSE 'rollback' END AS action \gset
SQL
}
outcome() {
  local code; code=$(sed -nE 's/^ERROR:  ([0-9A-Z]{5}): .*/\1/p' "$1" | head -1)
  if [ -n "$code" ]; then echo "$code"; return; fi
  grep -q 'service decision: LAST_OWNER' "$1" && { echo "decision:LAST_OWNER"; return; }
  grep -q '^committed$' "$1" && echo commit || echo no-commit
}
finish() { # emits COMMIT or ROLLBACK depending on the decision
  cat <<'SQL'
\if :{?action}
SELECT :'action' = 'commit' AS do_commit \gset
\if :do_commit
COMMIT;
SELECT 'committed';
\else
ROLLBACK;
\endif
\endif
SQL
}
for iso in "READ COMMITTED" "REPEATABLE READ"; do
  q -c "UPDATE project_members SET role='owner' WHERE project_id='$P1'" >/dev/null
  LA=$(mktemp); LB=$(mktemp)
  ({ svc "$iso" $U1 2; finish; } | q > "$LA" 2>&1) &
  sleep 0.5
  ({ svc "$iso" $U2 0; finish; } | q > "$LB" 2>&1) &
  wait
  a=$(outcome "$LA"); b=$(outcome "$LB"); owners=$(q -c "SELECT count(*) FROM project_members WHERE project_id='$P1' AND role='owner'")
  expb=$([ "$iso" = "READ COMMITTED" ] && echo decision:LAST_OWNER || echo 40001)
  v=PASS; [ "$a" = commit ] && [ "$b" = "$expb" ] && [ "$owners" = 1 ] || v=FAIL
  { [ "$a" = 40P01 ] || [ "$b" = 40P01 ]; } && v="FAIL (DEADLOCK 40P01)"
  [ "$v" = PASS ] || { fail=1; sed 's/^/   A: /' "$LA"; sed 's/^/   B: /' "$LB"; }
  echo "== C6 service algorithm, $iso: A=$a B=$b (expected commit/$expb) owners now: $owners  $v"
  rm -f -- "$LA" "$LB"
done
exit $fail
