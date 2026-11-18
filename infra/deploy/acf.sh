#!/usr/bin/env bash
# docker compose for the staging stack, with .env.production for variable substitution.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f "$dir/.env.production" ]]; then
  echo "missing $dir/.env.production: run $dir/generate-env.sh first" >&2
  exit 1
fi
exec docker compose --env-file "$dir/.env.production" -f "$dir/docker-compose.yml" "$@"
