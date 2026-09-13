#!/usr/bin/env bash
# Push templates/ to the GitLab CI/CD component project and tag the component
# version matching the sprout release. Called by .github/workflows/release.yml.
#
# Required env:
#   SPROUT_COMPONENT_PROJECT  component project path, e.g. <group>/sprout-ci
#   VERSION_TAG               sprout release tag, e.g. v0.6.0 (component tag)
# Optional env:
#   SPROUT_GITLAB_HOST        instance FQDN (default gitlab.com)
#   SPROUT_GITLAB_SYNC_TOKEN  token with write_repository on the project.
#                             When empty the sync is skipped (exit 0) so forks
#                             and token-less releases still succeed.
#   SOURCE_TEMPLATES_DIR      templates source dir (default <repo>/templates)
#
# Behavior:
# - clones the component project, rsyncs templates/, pins the sprout_version
#   input default to VERSION_TAG, commits "sprout <tag>", pushes, and pushes
#   tag <tag> (the component version). The pushed tag triggers the component
#   project's own tag pipeline, which creates the GitLab Release (catalog
#   version) via its `release:` job — see templates/README.md.
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

PROJECT="${SPROUT_COMPONENT_PROJECT:-}"
TAG="${VERSION_TAG:-}"
HOST="${SPROUT_GITLAB_HOST:-gitlab.com}"
TOKEN="${SPROUT_GITLAB_SYNC_TOKEN:-}"

if [ -z "$PROJECT" ] || [ -z "$TAG" ]; then
  printf 'component sync skipped: set SPROUT_COMPONENT_PROJECT and VERSION_TAG\n'
  exit 0
fi

if [ -z "$TOKEN" ]; then
  printf 'component sync skipped: SPROUT_GITLAB_SYNC_TOKEN is not set (would publish %s to %s)\n' "$TAG" "$PROJECT"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SOURCE_TEMPLATES_DIR:-${ROOT}/templates}"
[ -f "${SRC}/preview.yml" ] || fail "templates source missing: ${SRC}/preview.yml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 "https://oauth2:${TOKEN}@${HOST}/${PROJECT}.git" "$WORK/repo"
cd "$WORK/repo"

mkdir -p templates
# rsync keeps deletions in sync; fall back to cp when rsync is unavailable.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude '*.test.ts' "${SRC}/" templates/
else
  rm -f templates/preview.yml
  cp "${SRC}/preview.yml" templates/preview.yml
  # Mirror the first-sync README seed below (no rsync available).
  if [ ! -f README.md ]; then
    cp "${SRC}/README.md" README.md
  fi
fi

# Pin the sprout_version default to the release tag so the component version
# and the installed binary version coincide (templates/README.md).
perl -0pi -e 's/(sprout_version:\n(?:.*\n)*?\s+default:\s*")[^"]+(")/$1'"${TAG}"'$2/' templates/preview.yml
grep -q "default: \"${TAG}\"" templates/preview.yml \
  || fail "could not pin sprout_version default to ${TAG}"

# Component projects require a root README.md; seed it from the templates doc
# on first sync only (later edits belong to the component project).
if [ ! -f README.md ]; then
  cp "${SRC}/README.md" README.md
fi

git add templates/preview.yml README.md
if git diff --cached --quiet; then
  printf 'component sync: no changes for %s\n' "$TAG"
else
  git -c user.name="sprout-release" -c user.email="sprout-release@local" \
    commit -m "sprout ${TAG}"
  git push origin HEAD
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  printf 'component sync: tag %s already exists\n' "$TAG"
else
  git tag "$TAG"
  git push origin "$TAG"
fi

printf 'component sync ok: %s@%s\n' "$PROJECT" "$TAG"
