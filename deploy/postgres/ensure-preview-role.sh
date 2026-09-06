#!/bin/bash
# Create or sync the static preview login. Safe for passwords with quotes/special chars.
# Invoked by the ensure-preview-role one-shot service (TCP via PGHOST/PGPORT/PGPASSWORD),
# or run manually against an external Postgres instance with the same env.
set -euo pipefail

preview_user="${SPROUT_PG_USER:-pb_preview}"
preview_password="${SPROUT_PG_PASSWORD:?SPROUT_PG_PASSWORD must be set for preview role}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=preview_user="$preview_user" \
  --set=preview_password="$preview_password" <<'EOSQL'
SELECT CASE
  WHEN EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = :'preview_user')
  THEN format('ALTER ROLE %I LOGIN PASSWORD %L', :'preview_user', :'preview_password')
  ELSE format('CREATE ROLE %I LOGIN PASSWORD %L', :'preview_user', :'preview_password')
END
\gexec
EOSQL
