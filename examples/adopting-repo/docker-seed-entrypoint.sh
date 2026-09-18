#!/bin/sh
set -eu

: "${PGHOST:?PGHOST required}"
: "${PGPORT:?PGPORT required}"
: "${PGUSER:?PGUSER required}"
: "${PGDATABASE:?PGDATABASE required}"

until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"; do
  sleep 1
done

exec bun run seed "$@"
