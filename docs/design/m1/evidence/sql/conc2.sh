#!/usr/bin/env bash
DB=acf_design_spike
q() { docker exec -i acf-postgres-1 psql -U acf -d $DB -v ON_ERROR_STOP=1 -qtA "$@"; }
run_pair() { echo "== $1"; (echo "$2" | q 2>&1 | grep -vE "CONTEXT|SQL statement|PL/pgSQL" | sed 's/^/  A: /') & sleep 0.5; (echo "$3" | q 2>&1 | grep -vE "CONTEXT|SQL statement|PL/pgSQL" | sed 's/^/  B: /') & wait; }
P1=10000000-0000-7000-8000-000000000001; U1=00000000-0000-7000-8000-000000000001; U2=00000000-0000-7000-8000-000000000002
# Service algorithm: lock project, count owners (fresh statement), refuse if it would remove the last one, then update.
svc() { # isolation, user
cat <<SQL
BEGIN ISOLATION LEVEL $1;
SELECT 1 FROM projects WHERE id='$P1' FOR NO KEY UPDATE;
SELECT CASE WHEN count(*) <= 1 THEN 'LAST_OWNER -> 409, rollback' ELSE 'ok to demote' END AS decision FROM project_members WHERE project_id='$P1' AND role='owner' \gset
\echo :decision
SELECT pg_sleep(${3:-0});
UPDATE project_members SET role='editor' WHERE project_id='$P1' AND user_id='$2' AND :'decision' = 'ok to demote';
COMMIT;
SQL
}
for iso in "READ COMMITTED" "REPEATABLE READ"; do
  q -c "UPDATE project_members SET role='owner' WHERE project_id='$P1'"
  run_pair "C6 service algorithm, $iso" "$(svc "$iso" $U1 2)" "$(svc "$iso" $U2 0)"
  echo "  owners now: $(q -c "SELECT count(*) FROM project_members WHERE project_id='$P1' AND role='owner'")"
done
