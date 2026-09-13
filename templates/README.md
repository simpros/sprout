# sprout GitLab CI/CD component: `preview`

One-include previews for GitLab merge-request pipelines. The component is a
**thin bootstrapper**: it installs the pinned, checksum-verified `sprout`
binary and calls `sprout ci preview` / `sprout ci teardown`. All preview
logic (image build + push, seed image, deploy, MR note, dotenv emission,
log dump on failure) lives in the CLI — this file contains no reimplementation.

## Adopter quickstart

`.sprout.yaml` at the repo root (see `docs/adoption.md`), two masked CI
variables, and one include. No adopter shell scripts:

```yaml
# .gitlab-ci.yml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.6.0
    inputs: { stage: deploy }
```

Replace `<group>/sprout-ci` with the component project path on your GitLab
instance. The component declares both jobs:

- `sprout-preview` — builds + pushes images, deploys, writes
  `PREVIEW_URL=` to the dotenv artifact that feeds `environment:url`.
- `sprout-stop-preview` — `on_stop` teardown (environment Stop button, MR
  close/merge, `auto_stop_in` expiry).

Required CI variables (project or group settings):

| Variable | Type | Masked | Purpose |
|---|---|---|---|
| `SPROUT_URL` | Variable | yes | Gateway URL (or pass `sprout_url` input instead) |
| `SPROUT_TOKEN` | Variable | yes | Deploy token scoped to the repo's canonical id |
| `SPROUT_APP_ENV` | File | yes | Optional app secrets as one dotenv blob (read automatically by the CLI) |
| `SPROUT_SEED_ENV` | File | yes | Optional seed secrets, same shape |

`SPROUT_TOKEN` needs an `api` scope note target only for the MR comment:
the CLI posts/updates one MR note via `CI_JOB_TOKEN` automatically; no
extra token is required for that. Secrets never appear in job logs, CLI
output, or the MR note (the CLI prints only `preview_url=`).

Prerequisites on the GitLab side:

- Merge-request pipelines (`CI_PIPELINE_SOURCE=merge_request_event`; the jobs
  gate on `$CI_MERGE_REQUEST_IID`). Branch pipelines are refused by the CLI
  with a named error.
- A runner that can run privileged `docker:dind` (the component declares its
  own `docker:24` image + `docker:24-dind` service). To override the image
  (e.g. a mirrored registry), redefine the job's `image:`/`services:` in
  your `.gitlab-ci.yml` — job names merge by name. Keep it Alpine-based:
  the bootstrap installs prerequisites with `apk`.
- Container registry credentials come from the predefined
  `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD`; the component logs in
  automatically when they are present. The app tag is always
  `CI_REGISTRY_IMAGE:<SHA>`.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `sprout_version` | release tag shipping the file (e.g. `v0.6.0`) | CLI release to install. Defaults to the matching binary — component version and binary version coincide. Override to pin or trial another build. |
| `stage` | `deploy` | Stage for both jobs. |
| `sprout_url` | `""` (use `$SPROUT_URL`) | Gateway URL override. |
| `app_context` | `.` | Directory holding `.sprout.yaml`; the CLI builds (`docker build … .`) and resolves Dockerfiles relative to it. |
| `app_dockerfile` | `Dockerfile` | Preflight guard — must exist under `app_context` and match `.sprout.yaml` `build.dockerfile` (authoritative). |
| `seed_dockerfile` | `""` (no guard) | When set, must exist under `app_context` and match `.sprout.yaml` `seed.dockerfile` (authoritative). |
| `auto_stop_in` | `1 week` | `environment:auto_stop_in` for the preview. |
| `app_env_file` | `""` | Extra dotenv file passed as `--app-env-file` (on top of `SPROUT_APP_ENV`). |
| `seed_env_file` | `""` | Extra seed dotenv file passed as `--seed-env-file` (on top of `SPROUT_SEED_ENV`). |
| `dotenv_file` | `sprout-preview.env` | Project-root-relative dotenv artifact carrying `PREVIEW_URL` to `environment:url`. Parent directories must already exist (a bare filename always works). |
| `tail` | `200` | Gateway log lines printed when `sprout ci preview` fails. |
| `preview_extra_args` | `""` | Escape hatch appended to `sprout ci preview` (e.g. `--service api=image --seed-arg --reset`). Space-separated; globbing disabled. |

Image builds are driven by `.sprout.yaml` (`build.dockerfile`,
`seed.dockerfile` + `seed.env`/`seed.args`); the dockerfile inputs above are
existence guards that fail fast with a named error, not build configuration.

## Remote-include fallback

GitLab resolves `include: component` only on the same instance. Where the
component project is not available, include the tagged file directly (same
content, no shell):

```yaml
include:
  - remote: "https://raw.githubusercontent.com/simpros/sprout/v0.6.0/templates/preview.yml"
    inputs:
      sprout_version: v0.6.0
      stage: deploy
```

`remote:` includes cannot resolve the component version, so `sprout_version`
must be set explicitly (it must equal the tag in the URL). Prefer the
component include wherever the component project exists.

## Publishing (maintainers)

Tagging a sprout release publishes the matching component version
automatically — no manual step:

1. The GitHub `release` workflow builds `SHA256SUMS.txt` alongside the
   binaries (the component verifies the musl asset against it) and uploads
   all three to the release.
2. The workflow's `component` job rewrites the `sprout_version` default in a
   copy of `templates/preview.yml` to the release tag and pushes
   `templates/` to the configured GitLab component project, tagging
   `v<version>` there (`scripts/sync-gitlab-component.sh`).
3. The pushed tag triggers the component project's own tag pipeline, which
   creates the GitLab Release (catalog version).

Configuration (GitHub repo secrets):

| Secret / var | Purpose |
|---|---|
| `SPROUT_GITLAB_HOST` | GitLab instance FQDN (default `gitlab.com`). Repository variable. |
| `SPROUT_COMPONENT_PROJECT` | Component project path (e.g. `<group>/sprout-ci`). Repository variable. |
| `SPROUT_GITLAB_SYNC_TOKEN` | Token with `write_repository` on the component project. Secret. Absent token ⇒ the job logs a skip and succeeds. |

One-time setup of the component project itself (operator, on the GitLab
instance):

- Create the project with this `templates/` layout, a root `README.md`
  (copy this file), and a `.gitlab-ci.yml` that tests the component on
  branches and cuts the catalog release on tags:

  ```yaml
  stages: [test, release]

  include:
    - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@$CI_COMMIT_SHA
      inputs: { stage: test }

  create-release:
    stage: release
    image: registry.gitlab.com/gitlab-org/cli:latest
    script: echo "Creating release $CI_COMMIT_TAG"
    rules:
      - if: $CI_COMMIT_TAG
    release:
      tag_name: $CI_COMMIT_TAG
      description: "Release $CI_COMMIT_TAG of components in $CI_PROJECT_PATH"
  ```

- Set a project description, then enable **Settings → General →
  Visibility → CI/CD Catalog project** so versions appear in the catalog.

## Verification status

Static checks in this repo (`templates/preview.test.ts`: required inputs,
both CLI entrypoints, dotenv/`on_stop`/`auto_stop_in` wiring, dind service,
registry login, checksum verification, shell-syntax check of both scripts):

- [x] verified via `bun test templates/preview.test.ts`.

Live-instance checks (need a GitLab instance + runner; pending operator):

- [ ] `include: component` + `.sprout.yaml` + two CI variables produces a
  working seeded preview in a test repo, with no adopter shell script.
- [ ] Tagging a sprout release publishes the matching component version
  with no manual step.
- [ ] Remote-include fallback verified once against a tagged raw template.
