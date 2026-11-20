#!/usr/bin/env bash
# Backup and restore of the staging stack (M8 design §5, ADR-0020). Run through acf.sh:
#   ./acf.sh backup [name]      -> backups/<name or UTC timestamp>/{database.dump,objects/,objects.json,backup.json}
#   ./acf.sh restore <name>     -> onto an EMPTY stack (fresh volumes); refuses otherwise
# Secrets (.env.production) are not part of a backup: keep a private copy yourself.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
acf() { "$dir/acf.sh" "$@"; }
backups="$dir/backups"
pg_user="$(grep -E '^POSTGRES_USER=' "$dir/.env.production" | cut -d= -f2- || true)"
pg_db="$(grep -E '^POSTGRES_DB=' "$dir/.env.production" | cut -d= -f2- || true)"
pg_user="${pg_user:-acf}"
pg_db="${pg_db:-acf}"

die() { echo "✖ $*" >&2; exit 1; }

backup() {
  local name="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid backup name: $name"
  local out="$backups/$name"
  [[ ! -e "$out" ]] || die "$out already exists"
  mkdir -p "$out"
  echo "→ database dump"
  acf exec -T postgres pg_dump -U "$pg_user" -d "$pg_db" --format=custom --no-password > "$out/database.dump"
  echo "→ objects"
  acf run --rm -T --user "$(id -u):$(id -g)" backup node dist/cli/storage-cli.js export "/backups/$name/storage"
  echo "→ checks"
  acf run --rm -T --user "$(id -u):$(id -g)" backup node dist/cli/storage-cli.js verify "/backups/$name/storage"
  local commit tables
  commit="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  tables="$(acf exec -T postgres psql -U "$pg_user" -d "$pg_db" -At -c \
    "select string_agg(format('%s=%s', relname, n_live_tup), ',' order by relname) from pg_stat_user_tables")"
  cat > "$out/backup.json" <<JSON
{
  "format": "acf-backup/1",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$commit",
  "database": "database.dump",
  "objects": "storage/objects.json",
  "approximateRows": "$tables"
}
JSON
  # Keep the last 7 backups on the VM; copy them off the VM yourself (DEPLOYMENT.md).
  ls -1d "$backups"/*/ 2>/dev/null | sort | head -n -7 | while read -r old; do
    echo "→ removing old backup $old"; rm -r -- "$old"
  done
  echo "✔ backup $out ($(du -sh "$out" | cut -f1))"
}

restore() {
  local name="${1:?usage: acf.sh restore <name>}"
  local src="$backups/$name"
  [[ -f "$src/database.dump" && -f "$src/storage/objects.json" ]] || die "$src is not a backup"
  echo "→ starting storage services"
  acf up -d postgres redis seaweedfs
  local tables
  tables="$(acf exec -T postgres psql -U "$pg_user" -d "$pg_db" -At -c \
    "select count(*) from pg_tables where schemaname = 'public'")"
  [[ "$tables" == "0" ]] || die "the database is not empty ($tables tables): restore needs fresh volumes (DEPLOYMENT.md)"
  echo "→ roles and grants"
  acf run --rm -T migrate node packages/database/scripts/db-setup.mjs bootstrap
  echo "→ database"
  acf exec -T postgres pg_restore -U "$pg_user" -d "$pg_db" --exit-on-error --no-password < "$src/database.dump"
  acf run --rm -T migrate node packages/database/scripts/db-setup.mjs bootstrap
  echo "→ bucket and objects"
  acf run --rm -T storage-setup
  acf run --rm -T --user "$(id -u):$(id -g)" backup node dist/cli/storage-cli.js import "/backups/$name/storage"
  echo "→ checks (checksums of every object)"
  acf run --rm -T --user "$(id -u):$(id -g)" backup node dist/cli/storage-cli.js verify "/backups/$name/storage" --deep
  echo "→ migrations up to date"
  acf run --rm -T migrate
  echo "✔ restored $name. Start the stack: ./acf.sh up -d"
}

case "${1:-}" in
  backup) shift; backup "$@" ;;
  restore) shift; restore "$@" ;;
  *) die "usage: acf.sh backup [name] | acf.sh restore <name>" ;;
esac
