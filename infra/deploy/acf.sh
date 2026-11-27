#!/usr/bin/env bash
# docker compose for the staging stack, with .env.production for variable substitution.
# `./acf.sh backup [name]`, `./acf.sh restore <name>` and `./acf.sh backup-schedule …` run
# backup.sh (M8, ADR-0020; M8.5 Q9).
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f "$dir/.env.production" ]]; then
  echo "missing $dir/.env.production: run $dir/generate-env.sh first" >&2
  exit 1
fi
case "${1:-}" in
  backup | restore | backup-schedule) exec "$dir/backup.sh" "$@" ;;
esac
exec docker compose --env-file "$dir/.env.production" -f "$dir/docker-compose.yml" "$@"
