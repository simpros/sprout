#!/usr/bin/env bash
# Compile-asset contract: outfile names + ELF interpreters (no Docker).
# Expects dist/sprout-linux-x64 (glibc) and dist/sprout-linux-x64-musl (musl).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIST="${ROOT}/dist"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "missing compile asset: $path"
  [[ -x "$path" ]] || fail "compile asset is not executable: $path"
}

interpreter_of() {
  local path="$1"
  readelf -l "$path" | awk -F': ' '/Requesting program interpreter/ { gsub(/]/,"",$2); print $2; exit }'
}

assert_interpreter() {
  local path="$1"
  local want="$2"
  local got
  got="$(interpreter_of "$path")"
  [[ -n "$got" ]] || fail "no ELF interpreter in $path"
  [[ "$got" == "$want" ]] || fail "$path: ELF interpreter want=$want got=$got"
}

require_file "${DIST}/sprout-linux-x64"
require_file "${DIST}/sprout-linux-x64-musl"

assert_interpreter "${DIST}/sprout-linux-x64" "/lib64/ld-linux-x86-64.so.2"
assert_interpreter "${DIST}/sprout-linux-x64-musl" "/lib/ld-musl-x86_64.so.1"

printf 'compile assets ok: sprout-linux-x64 (glibc), sprout-linux-x64-musl (musl)\n'
