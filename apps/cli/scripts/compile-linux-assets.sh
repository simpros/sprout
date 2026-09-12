#!/usr/bin/env bash
# Single source of truth for Linux release assets:
# bun-target | outfile-basename | expected ELF interpreter
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI_SRC="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${ROOT}/dist"
VERSION="${SPROUT_CLI_VERSION:-dev}"

ASSETS=(
  'bun-linux-x64|sprout-linux-x64|/lib64/ld-linux-x86-64.so.2'
  'bun-linux-x64-musl|sprout-linux-x64-musl|/lib/ld-musl-x86_64.so.1'
)

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

interpreter_of() {
  local path="$1"
  readelf -l "$path" | awk -F': ' '/Requesting program interpreter/ { gsub(/[\[\]]/,"",$2); print $2; exit }'
}

mkdir -p "$DIST"

for row in "${ASSETS[@]}"; do
  IFS='|' read -r target basename want <<<"$row"
  outfile="${DIST}/${basename}"

  (
    cd "$CLI_SRC"
    bun build --compile \
      --target="$target" \
      --define "SPROUT_CLI_VERSION=\"${VERSION}\"" \
      --outfile "$outfile" \
      ./src/index.ts
  )

  [[ -f "$outfile" ]] || fail "missing compile asset: $outfile"
  [[ -x "$outfile" ]] || fail "compile asset is not executable: $outfile"

  got="$(interpreter_of "$outfile")"
  [[ -n "$got" ]] || fail "no ELF interpreter in $outfile"
  [[ "$got" == "$want" ]] || fail "$outfile: ELF interpreter want=$want got=$got"
done

printf 'compile assets ok:'
for row in "${ASSETS[@]}"; do
  IFS='|' read -r _ basename _ <<<"$row"
  printf ' %s' "$basename"
done
printf '\n'
