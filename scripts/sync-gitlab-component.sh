#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

PROJECT="${SPROUT_COMPONENT_PROJECT:-}"
TAG="${VERSION_TAG:-}"
HOST="${SPROUT_GITLAB_HOST:-gitlab.com}"
TOKEN="${SPROUT_GITLAB_SYNC_TOKEN:-}"

if [ -z "$PROJECT" ]; then
  printf 'component sync skipped: SPROUT_COMPONENT_PROJECT is not set\n'
  exit 0
fi

[ -n "$TAG" ] || fail "component sync misconfigured: SPROUT_COMPONENT_PROJECT is set but VERSION_TAG is empty"
[ -n "$TOKEN" ] || fail "component sync misconfigured: SPROUT_COMPONENT_PROJECT is set but SPROUT_GITLAB_SYNC_TOKEN is empty (would publish ${TAG} to ${PROJECT})"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SOURCE_TEMPLATES_DIR:-${ROOT}/templates}"
[ -f "${SRC}/preview.yml" ] || fail "templates source missing: ${SRC}/preview.yml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CLONE_URL="${SPROUT_COMPONENT_GIT_URL:-https://oauth2:${TOKEN}@${HOST}/${PROJECT}.git}"
git clone --depth 1 "$CLONE_URL" "$WORK/repo"
cd "$WORK/repo"

rm -rf templates
mkdir -p templates
cp "${SRC}/preview.yml" templates/preview.yml

SENTINEL="@SPROUT_COMPONENT_VERSION@"
sed -i "s/${SENTINEL}/${TAG}/g" templates/preview.yml
grep -q "$SENTINEL" templates/preview.yml \
  && fail "sentinel ${SENTINEL} still present after pinning to ${TAG}"
grep -q "default: \"${TAG}\"" templates/preview.yml \
  || fail "could not pin sprout_version default to ${TAG}"

if [ ! -f README.md ]; then
  cp "${SRC}/README.md" README.md
fi

git add -A templates README.md

# Shallow clones omit stale tags, so decide against the remote tag.
REMOTE_SHA="$(git ls-remote --tags origin "refs/tags/${TAG}^{}" "refs/tags/${TAG}" \
  | awk '/\^\{\}$/ { peeled = $1 } { last = $1 } END { print (peeled != "" ? peeled : last) }')"
if ! git diff --cached --quiet; then
  if [ -n "$REMOTE_SHA" ]; then
    fail "component sync: tag ${TAG} already exists; refusing to push new content under a frozen tag"
  fi
  git -c user.name="sprout-release" -c user.email="sprout-release@local" \
    commit -m "sprout ${TAG}"
  git tag "$TAG"
  git push --atomic origin HEAD "refs/tags/${TAG}"
  HEAD_SHA="$(git rev-parse HEAD)"
else
  printf 'component sync: no changes for %s\n' "$TAG"
  HEAD_SHA="$(git rev-parse HEAD)"
  if [ -n "$REMOTE_SHA" ]; then
    if [ "$REMOTE_SHA" != "$HEAD_SHA" ]; then
      fail "component sync: tag ${TAG} already exists at ${REMOTE_SHA} (HEAD is ${HEAD_SHA}); refusing to leave @${TAG} on stale content"
    fi
    git rev-parse "$TAG" >/dev/null 2>&1 || git tag "$TAG"
    printf 'component sync: tag %s already points at HEAD\n' "$TAG"
  else
    git tag "$TAG"
    git push --atomic origin "refs/tags/${TAG}"
  fi
fi

printf 'component sync ok: %s@%s\n' "$PROJECT" "$TAG"
