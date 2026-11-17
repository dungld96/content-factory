#!/usr/bin/env bash
# Runs two psql sessions concurrently. A starts first and sleeps inside its transaction.
DB=acf_design_spike
q() { docker exec -i acf-postgres-1 psql -U acf -d $DB -v ON_ERROR_STOP=1 -qtA "$@"; }
run_pair() { # name, sqlA, sqlB
  echo "== $1"
  (echo "$2" | q 2>&1 | sed 's/^/  A: /') &
  sleep 0.5
  (echo "$3" | q 2>&1 | sed 's/^/  B: /') &
  wait
}
P1=10000000-0000-7000-8000-000000000001
C=30000000-0000-7000-8000-000000000001
U1=00000000-0000-7000-8000-000000000001
U2=00000000-0000-7000-8000-000000000002

# setup: make user2 a second owner of P1; create drafts v3, v4 and v5
q -c "UPDATE project_members SET role='owner' WHERE project_id='$P1' AND user_id='$U2'"
q -c "INSERT INTO character_versions (id, project_id, character_id, version, description, created_by_id, updated_at) VALUES
  ('31000000-0000-7000-8000-000000000003','$P1','$C',3,'v3','$U1',now()),
  ('31000000-0000-7000-8000-000000000004','$P1','$C',4,'v4','$U1',now()),
  ('31000000-0000-7000-8000-000000000005','$P1','$C',5,'v5','$U1',now())"

run_pair "C1 two owners demote each other concurrently (READ COMMITTED) -> exactly one must fail" \
"BEGIN; UPDATE project_members SET role='editor' WHERE project_id='$P1' AND user_id='$U1'; SELECT pg_sleep(2); COMMIT; SELECT 'A committed';" \
"BEGIN; UPDATE project_members SET role='editor' WHERE project_id='$P1' AND user_id='$U2'; COMMIT; SELECT 'B committed';"
echo "  owners now: $(q -c "SELECT count(*) FROM project_members WHERE project_id='$P1' AND role='owner'")"

run_pair "C2 link insert races an in-flight approval of v3 -> link must be rejected" \
"BEGIN; SELECT 1 FROM characters WHERE id='$C' FOR NO KEY UPDATE; SELECT id FROM character_versions WHERE id='31000000-0000-7000-8000-000000000003' FOR UPDATE;
 UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U1' WHERE id='31000000-0000-7000-8000-000000000003';
 UPDATE characters SET master_version_id='31000000-0000-7000-8000-000000000003' WHERE id='$C'; SELECT pg_sleep(2); COMMIT; SELECT 'A approved v3';" \
"INSERT INTO character_version_assets (project_id, character_version_id, asset_id) VALUES ('$P1','31000000-0000-7000-8000-000000000003','20000000-0000-7000-8000-000000000003'); SELECT 'B linked (BAD)';"
echo "  links on v3: $(q -c "SELECT count(*) FROM character_version_assets WHERE character_version_id='31000000-0000-7000-8000-000000000003'")"

run_pair "C3 approvals of v5 (A, first) and v4 (B) race WITHOUT a service lock -> v4 must not become master" \
"BEGIN; UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U1' WHERE id='31000000-0000-7000-8000-000000000005';
 UPDATE characters SET master_version_id='31000000-0000-7000-8000-000000000005' WHERE id='$C'; SELECT pg_sleep(2); COMMIT; SELECT 'A approved v5';" \
"BEGIN; UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U2' WHERE id='31000000-0000-7000-8000-000000000004';
 UPDATE characters SET master_version_id='31000000-0000-7000-8000-000000000004' WHERE id='$C'; COMMIT; SELECT 'B approved v4 (BAD)';"
echo "  master now: v$(q -c "SELECT v.version FROM characters c JOIN character_versions v ON v.id=c.master_version_id WHERE c.id='$C'"); v4 status: $(q -c "SELECT status FROM character_versions WHERE version=4")"

run_pair "C4 same version (v4) approved twice concurrently with the service algorithm -> second is a no-op" \
"BEGIN; SELECT 1 FROM characters WHERE id='$C' FOR NO KEY UPDATE; SELECT pg_sleep(2);
 UPDATE character_versions SET status='approved', approved_at=now(), approved_by_id='$U1' WHERE id='31000000-0000-7000-8000-000000000004' AND status='draft' RETURNING 'A updated row'; ROLLBACK;" \
"BEGIN; SELECT 1 FROM characters WHERE id='$C' FOR NO KEY UPDATE; SELECT status FROM character_versions WHERE id='31000000-0000-7000-8000-000000000004'; COMMIT; SELECT 'B ran after A released lock';"

# reset owners for C5
q -c "UPDATE project_members SET role='owner' WHERE project_id='$P1'"
run_pair "C5 HAZARD CHECK: same as C1 but REPEATABLE READ" \
"BEGIN ISOLATION LEVEL REPEATABLE READ; UPDATE project_members SET role='editor' WHERE project_id='$P1' AND user_id='$U1'; SELECT pg_sleep(2); COMMIT; SELECT 'A committed';" \
"BEGIN ISOLATION LEVEL REPEATABLE READ; UPDATE project_members SET role='editor' WHERE project_id='$P1' AND user_id='$U2'; COMMIT; SELECT 'B committed';"
echo "  owners now: $(q -c "SELECT count(*) FROM project_members WHERE project_id='$P1' AND role='owner'")"
