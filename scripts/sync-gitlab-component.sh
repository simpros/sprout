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
#                             When the project is configured but the token is
#                             empty the sync FAILS (misconfigured release);
#                             when the project itself is unset the sync is
#                             skipped (exit 0) so forks still succeed.
#   SOURCE_TEMPLATES_DIR      templates source dir (default <repo>/templates)
#   SPROUT_COMPONENT_GIT_URL  full clone URL override (tests only; defaults to
#                             https://oauth2:<token>@<host>/<project>.git).
#
# Behavior:
# - clones the component project, copies preview.yml to templates/,
#   replaces the @SPROUT_COMPONENT_VERSION@ sentinel with VERSION_TAG,
#   commits "sprout <tag>", pushes, and pushes tag <tag> (the component
#   version). The pushed tag triggers the component project's own tag
#   pipeline, which creates the GitLab Release (catalog version) via its
#   `release:` job — see templates/README.md.
# - the component project is "one file + root README": only
#   templates/preview.yml is synced. Staging uses `git add -A` so deletions
#   and orphans enter the commit instead of lingering in the working tree.
# - if tag <tag> already exists and new content would be pushed, the script
#   FAILS *before* pushing anything, so the default branch never advances
#   under a frozen tag (workflow_dispatch rebuilds must not green-check while
#   @vX.Y.Z resolves old content, nor leave a branch/tag split behind).
#   A tag that already points at HEAD is success ("already points at HEAD").
# - branch and tag publish together via one `git push --atomic`, so a
#   mid-flight failure cannot leave the default branch advanced with the
#   catalog tag missing.
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

PROJECT="${SPROUT_COMPONENT_PROJECT:-}"
TAG="${VERSION_TAG:-}"
HOST="${SPROUT_GITLAB_HOST:-gitlab.com}"
TOKEN="${SPROUT_GITLAB_SYNC_TOKEN:-}"

# Opt-in publishing: only the unset project means "no catalog" (forks).
if [ -z "$PROJECT" ]; then
  printf 'component sync skipped: SPROUT_COMPONENT_PROJECT is not set\n'
  exit 0
fi

# Half-configured production release: project set but tag or token missing.
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

# One file + root README: no rsync mirror, no cp/rsync fork. Clear the
# directory first so orphans from earlier syncs cannot linger on disk and
# survive staging into future tags — `git add -A` only stages deletions for
# files it can see are gone.
rm -rf templates
mkdir -p templates
cp "${SRC}/preview.yml" templates/preview.yml

# Pin the sprout_version default: source carries the unambiguous sentinel
# `default: "@SPROUT_COMPONENT_VERSION@"`; the published component carries
# the release tag so component version and binary version coincide.
SENTINEL="@SPROUT_COMPONENT_VERSION@"
sed -i "s/${SENTINEL}/${TAG}/g" templates/preview.yml
grep -q "$SENTINEL" templates/preview.yml \
  && fail "sentinel ${SENTINEL} still present after pinning to ${TAG}"
grep -q "default: \"${TAG}\"" templates/preview.yml \
  || fail "could not pin sprout_version default to ${TAG}"

# Component projects require a root README.md; seed it from the templates doc
# on first sync only (later edits belong to the component project).
if [ ! -f README.md ]; then
  cp "${SRC}/README.md" README.md
fi

git add -A templates README.md

# Decide against the REMOTE tag before pushing anything: the clone above is
# `--depth 1`, so tags that do not point at the fetched tip are usually
# absent locally and a `git rev-parse "$TAG"` check would miss the stale-tag
# case (degrading to a raw `git push` rejection with a vaguer message).
# The `^{}` pattern resolves annotated tags to their commit; the awk prefers
# the peeled line and falls back to the tip for lightweight tags.
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
