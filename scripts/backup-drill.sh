#!/usr/bin/env bash
# Restore drill on the local development stack (M8 design §5, ADR-0020): the same commands as
# infra/deploy/backup.sh (pg_dump/pg_restore inside the PostgreSQL container, the storage CLI),
# restored into a SCRATCH database and a SCRATCH bucket, then compared table by table and
# verified object by object. The development database and bucket are only read.
#   pnpm build && scripts/backup-drill.sh
# Source defaults to the development database and bucket; DRILL_DB / DRILL_BUCKET pick others
# (e.g. the E2E run's acf_test_e2e / acf-test-e2e, which hold real images, clips and renders).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
. "$root/.env"
set +a
container="${ACF_POSTGRES_CONTAINER:-acf-postgres-1}"
source_db="${DRILL_DB:-$POSTGRES_DB}"
source_bucket="${DRILL_BUCKET:-$S3_BUCKET}"
stamp="$(date -u +%Y%m%d%H%M%S)"
scratch_db="acf_drill_${stamp}"
scratch_bucket="acf-drill-${stamp}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pg() { docker exec -i "$container" "$@"; }
cli() { node "$root/apps/api/dist/cli/storage-cli.js" "$@"; }

echo "→ backup: database ($source_db) and objects ($source_bucket)"
pg pg_dump -U "$POSTGRES_USER" -d "$source_db" --format=custom --no-password > "$work/database.dump"
S3_BUCKET="$source_bucket" cli export "$work/storage"

echo "→ restore into $scratch_db and $scratch_bucket"
pg createdb -U "$POSTGRES_USER" "$scratch_db"
pg pg_restore -U "$POSTGRES_USER" -d "$scratch_db" --exit-on-error --no-password < "$work/database.dump"
S3_BUCKET="$scratch_bucket" node "$root/packages/storage/scripts/storage-setup.mjs"
S3_BUCKET="$scratch_bucket" cli import "$work/storage"

echo "→ compare every table (exact row counts)"
counts() {
  pg psql -U "$POSTGRES_USER" -d "$1" -At -c "
    select string_agg(t || '=' || n, E'\n' order by t) from (
      select c.relname as t,
             (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text as n
      from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = 'public' and c.relkind = 'r') x"
}
counts "$source_db" > "$work/source.txt"
counts "$scratch_db" > "$work/restored.txt"
if diff -u "$work/source.txt" "$work/restored.txt"; then
  echo "✔ $(wc -l < "$work/source.txt") tables, identical row counts"
else
  echo "✖ row counts differ" >&2
  exit 1
fi
migrations="$(pg psql -U "$POSTGRES_USER" -d "$scratch_db" -At -c 'select count(*) from _prisma_migrations where finished_at is not null')"
echo "✔ $migrations migrations recorded in the restored database"

echo "→ verify objects against the manifest and the restored database (checksums)"
restored_url="${DATABASE_URL%/*}/${scratch_db}"
DATABASE_URL="$restored_url" S3_BUCKET="$scratch_bucket" cli verify "$work/storage" --deep

echo "✔ restore drill passed. Scratch database $scratch_db and bucket $scratch_bucket are left for inspection;"
echo "  remove them when done: docker exec $container dropdb -U $POSTGRES_USER $scratch_db"
