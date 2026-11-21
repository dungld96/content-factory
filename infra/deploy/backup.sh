#!/usr/bin/env bash
# Backup and restore of the staging stack (M8 design §5, ADR-0020). Run through acf.sh:
#   ./acf.sh backup [name]      -> backups/<name or UTC timestamp>/{database.dump,objects/,objects.json,backup.json}
#   ./acf.sh restore <name>     -> onto an EMPTY stack (fresh volumes); refuses otherwise
#   ./acf.sh backup-schedule install|remove|status -> one nightly cron line, 02:15 (M8.5 Q9)
# With BACKUP_REMOTE in .env.production (an rclone remote and path, e.g. `offsite:acf-backups`:
# any S3-compatible storage, Backblaze B2 or an SFTP server, set up with `rclone config`), each
# backup is copied to <remote>/<name>/ and remote copies older than BACKUP_REMOTE_KEEP_DAYS
# (default 30) are deleted; old local copies
# beyond the last 7 are removed only after a successful copy. A failure prints one line with
# the alert event `backup_failed` and exits non-zero.
# Secrets (.env.production) are not part of a backup: keep a private copy yourself.
set -Eeuo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
acf() { "$dir/acf.sh" "$@"; }
backups="$dir/backups"
pg_user="$(grep -E '^POSTGRES_USER=' "$dir/.env.production" | cut -d= -f2- || true)"
pg_db="$(grep -E '^POSTGRES_DB=' "$dir/.env.production" | cut -d= -f2- || true)"
remote="$(grep -E '^BACKUP_REMOTE=' "$dir/.env.production" | cut -d= -f2- || true)"
remote="${remote%/}"
remote_days="$(grep -E '^BACKUP_REMOTE_KEEP_DAYS=' "$dir/.env.production" | cut -d= -f2- || true)"
remote_days="${remote_days:-30}"
pg_user="${pg_user:-acf}"
pg_db="${pg_db:-acf}"
keep=7
cron_tag='# acf-backup (M8.5)'

die() { echo "✖ $*" >&2; exit 1; }
# One line per failure for log-based alerting (DEPLOYMENT.md, "Alert events").
failed() {
  echo "{\"event\":\"backup_failed\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"stage\":\"$1\",\"backup\":\"$2\"}" >&2
  exit 1
}

backup() {
  local name="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid backup name: $name"
  local out="$backups/$name"
  [[ ! -e "$out" ]] || die "$out already exists"
  mkdir -p "$out"
  # A partial backup is useless: remove it so it is never pruned into or restored from.
  trap 'rm -r -- "$out"; failed backup "$name"' ERR
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
  trap - ERR
  echo "✔ backup $out ($(du -sh "$out" | cut -f1))"
  ship "$name"
}

# Off-server copy (when a remote is configured), then pruning: never prune after a failed copy.
ship() {
  local name="${1:?usage: backup.sh ship <name>}"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ && -f "$backups/$name/backup.json" ]] || die "$backups/$name is not a backup"
  if [[ -n "$remote" ]]; then
    [[ "$remote" =~ ^[A-Za-z0-9_-]+:[A-Za-z0-9._-][A-Za-z0-9._/-]*$ && "$remote_days" =~ ^[1-9][0-9]*$ ]] \
      || failed "offsite-config" "$name"
    local target="$remote/$name"
    echo "→ copying to $target"
    rclone copy --exclude /backup.json "$backups/$name" "$target" || failed offsite "$name"
    # The manifest goes last: a remote copy with backup.json is complete.
    rclone copyto "$backups/$name/backup.json" "$target/backup.json" || failed offsite "$name"
    echo "✔ copied to $target"
    echo "→ removing remote copies older than $remote_days days"
    rclone delete --min-age "${remote_days}d" --rmdirs "$remote" || failed offsite-prune "$name"
  fi
  prune
}

# Keep the last $keep backups on the server (directories only; the log file stays).
prune() {
  ls -1d "$backups"/*/ 2>/dev/null | sort | head -n -"$keep" | while read -r old; do
    echo "→ removing old local backup $old"; rm -r -- "$old"
  done
}

# One cron line, tagged so it can be found and removed again. Cron uses the server's time zone
# (DEPLOYMENT.md sets the server to UTC).
schedule() {
  local line="15 2 * * * PATH=/usr/local/bin:/usr/bin:/bin; cd $dir && ./acf.sh backup >> $backups/backup.log 2>&1 $cron_tag"
  local current
  current="$(crontab -l 2>/dev/null || true)"
  case "${1:-}" in
    install)
      mkdir -p "$backups"
      { grep -vF "$cron_tag" <<<"$current" || true; echo "$line"; } | sed '/^$/d' | crontab -
      echo "✔ nightly backup at 02:15 (log: $backups/backup.log)${remote:+, copied to $remote/}"
      ;;
    remove)
      { grep -vF "$cron_tag" <<<"$current" || true; } | sed '/^$/d' | crontab -
      echo "✔ nightly backup removed"
      ;;
    status)
      if grep -qF "$cron_tag" <<<"$current"; then
        echo "scheduled: $(grep -F "$cron_tag" <<<"$current")"
      else
        echo "not scheduled"
      fi
      echo "off-server copy: ${remote:+$remote/ (kept $remote_days days)}${remote:-off (BACKUP_REMOTE not set)}"
      local last
      last="$(ls -1d "$backups"/*/ 2>/dev/null | sort | tail -n 1 || true)"
      echo "latest local backup: ${last:-none}"
      if [[ -f "$backups/backup.log" ]] && grep -q backup_failed "$backups/backup.log"; then
        echo "last failure: $(grep backup_failed "$backups/backup.log" | tail -n 1)"
      fi
      ;;
    *) die "usage: acf.sh backup-schedule install|remove|status" ;;
  esac
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
  ship) shift; ship "$@" ;;
  backup-schedule) shift; schedule "$@" ;;
  *) die "usage: acf.sh backup [name] | restore <name> | backup-schedule install|remove|status" ;;
esac
