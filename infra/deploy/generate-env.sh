#!/usr/bin/env bash
# Writes infra/deploy/.env.production with fresh random secrets (git-ignored, mode 600).
# Usage: ./generate-env.sh <site-address>   e.g. acf.example.com or 34.1.2.3.sslip.io
set -euo pipefail
umask 077
dir="$(cd "$(dirname "$0")" && pwd)"
out="$dir/.env.production"
site="${1:?usage: $0 <site-address, e.g. acf.example.com or 34.1.2.3.sslip.io>}"
if [[ -e "$out" ]]; then
  echo "$out already exists; refusing to overwrite (it holds the database passwords)" >&2
  exit 1
fi
rand() { openssl rand -hex 24; }
pg="$(rand)"
migrator="$(rand)"
app="$(rand)"
cat > "$out" <<ENV
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ). Never commit or share this file.
SITE_ADDRESS=$site
POSTGRES_USER=acf
POSTGRES_PASSWORD=$pg
POSTGRES_DB=acf
DATABASE_ADMIN_URL=postgresql://acf:$pg@postgres:5432/acf
DATABASE_MIGRATION_URL=postgresql://acf_migrator:$migrator@postgres:5432/acf?schema=public
DATABASE_URL=postgresql://acf_app:$app@postgres:5432/acf?schema=public
SESSION_SECRETS=$(rand)$(rand)
CSRF_SECRET=$(rand)$(rand)
LOG_LEVEL=log
# Optional, paid: real LLM calls. Set it, then: ./acf.sh up -d api worker
OPENROUTER_API_KEY=
ENV
echo "✔ wrote $out (site: https://$site)"
