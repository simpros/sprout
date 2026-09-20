<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# sprout GitLab CI/CD component: `preview`

One-include previews for GitLab merge-request pipelines. The component is a
**thin bootstrapper**: it installs the pinned, checksum-verified `sprout`
binary and calls `sprout ci preview` / `sprout ci teardown`. All preview
logic (image build + push, seed image, deploy, MR note, dotenv emission,
log dump on failure) lives in the CLI — this file contains no reimplementation.

## Adopter quickstart

`.sprout.yaml` at the repo root (see `docs/adoption.md`), two required masked CI
variables (plus optional `GITLAB_TOKEN` for MR notes), and one include. No adopter shell scripts:

```yaml
# .gitlab-ci.yml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.7.0
    inputs: { stage: deploy }
```

Replace `<group>/sprout-ci` with the component project path on your GitLab
instance. The component declares three jobs:

- `sprout-preview` — builds + pushes images, deploys, writes
  `PREVIEW_URL=` to the dotenv artifact that feeds `environment:url`.
- `sprout-stop-preview` — `on_stop` teardown (environment Stop button, MR
  close/merge, `auto_stop_in` expiry).
- `sprout-reset` — manual one-click wipe + redeploy + seed
  (`sprout ci reset`, data wiped). Play it from the MR pipeline when you
  want the reset *now*.

CI variables (project or group settings):

| Variable | Type | Masked | Purpose |
|---|---|---|---|
| `SPROUT_URL` | Variable | yes | Gateway URL (or pass `sprout_url` input instead) |
| `SPROUT_TOKEN` | Variable | yes | Deploy token scoped to the repo's canonical id |
| `SPROUT_APP_ENV` | File | yes | Optional app secrets as one dotenv blob (read automatically by the CLI) |
| `SPROUT_SEED_ENV` | File | yes | Optional seed secrets, same shape |
| `GITLAB_TOKEN` | Variable | yes | Optional MR-note token with note-write (e.g. a project access token). When set, the CLI posts/updates the MR note with it (`PRIVATE-TOKEN`); otherwise it falls back to `CI_JOB_TOKEN` (`JOB-TOKEN`), which can read but not create notes on some instances (401) |

Secrets never appear in job logs, CLI output, or the MR note (the CLI prints only `preview_url=`).

## Reset request checkbox

Tick a box in the MR description and the next preview run wipes the database
and redeploys from scratch — no webhook, no extra token. Paste
[`templates/reset-request-snippet.md`](./reset-request-snippet.md) at the top
of the MR description:

```markdown
- [ ] Sprout: reset preview <!-- sprout-reset: ada-2026-09-19-1 -->
```

To request a reset, tick the box **and** change the token to something new.
Paste the snippet at the top of the description (GitLab
exposes only that prefix to CI; truncation fails the job loudly instead of
ignoring the tick). A handled marker never fires twice — re-runs and retries
deploy normally; `sprout ci reset` consumes a pending request too.

Prerequisites on the GitLab side:

- Merge-request pipelines (`CI_PIPELINE_SOURCE=merge_request_event`; the jobs
  gate on `$CI_MERGE_REQUEST_IID`). Branch pipelines are refused by the CLI
  with a named error.
- A runner that can run privileged `docker:dind` (the preview job runs on
  `docker:24` + a `docker:24-dind` service; the stop/teardown and reset jobs
  run on `alpine:3.20` and share only the CLI install — no Docker daemon, no
  Docker client pull). To override
  the image
  (e.g. a mirrored registry), redefine the job's `image:`/`services:` in
  your `.gitlab-ci.yml` — job names merge by name. Keep it Alpine-based:
  the bootstrap installs prerequisites with `apk`.
- Container registry credentials come from the predefined
  `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD`; the component logs in
  automatically when they are present. The app tag is always
  `CI_REGISTRY_IMAGE:<SHA>`.

## Reset: ticked box vs manual job

Two paths, one operation (`sprout ci reset`: teardown for this MR, then a
deploy that recreates the database and re-runs the seed — data wiped,
unlike `--reseed`, which re-runs the seed against the existing database):

- **Ticked box (declarative):** tick the reset box in the MR description and
  the *next* pipeline run honors it. GitLab has no "description edited → run
  a pipeline" trigger, so a tick waits for the next push or pipeline run.
- **Manual job (instant):** press **Run** on `sprout-reset` inside the
  existing MR pipeline to reset without a new commit. The job runs the
  pipeline's own pinned CLI version with the same inputs as
  `sprout-preview` (no Docker daemon needed — a reset reuses the already
  pushed images, so the job shares only the CLI install like the stop job).

Why the manual job exists: the obvious GitLab instant answers are dead ends.
A fresh "Run pipeline" from the UI arrives as `CI_PIPELINE_SOURCE=web`,
which `sprout ci` refuses by design (only merge-request pipelines deploy),
so the instantaneous path has to be a job *inside* the existing MR pipeline.
Like the stop job, it is `when: manual` at job level plus `allow_failure:
true`, so an MR pipeline nobody resets stays green with zero clicks.
A reset while another deploy is in flight exits `409
preview_deploy_in_progress` (or `preview_teardown_in_progress`) — wait for
the current run to settle and retry; never run `sprout-preview` and
`sprout-reset` at the same time. On `db.provider: none` or `sqlite` previews
the reset still redeploys, but there is no Postgres database to wipe (`none`
redeploys containers only; `sqlite` drops and recreates the named
per-preview volume).

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `sprout_version` | release tag shipping the file (e.g. `v0.6.0`) | CLI release to install. The source carries the sentinel `@SPROUT_COMPONENT_VERSION@`, which the release pipeline replaces with the published tag — component version and binary version coincide. Override to pin or trial another build. |
| `stage` | `deploy` | Stage for all three jobs. |
| `sprout_url` | `""` (use `$SPROUT_URL`) | Gateway URL override. |
| `app_context` | `.` | Directory holding `.sprout.yaml`; the CLI builds (`docker build … .`) and resolves Dockerfiles relative to it. |
| `auto_stop_in` | `1 week` | `environment:auto_stop_in` for the preview. |
| `app_env_file` | `""` | Project-root-relative extra dotenv file passed as `--app-env-file` (on top of `SPROUT_APP_ENV`). Resolved before `cd` into `app_context`, same rule as `dotenv_file`. Repo-relative path only — not a File CI variable ([Troubleshooting](#troubleshooting)). |
| `seed_env_file` | `""` | Project-root-relative extra seed dotenv file passed as `--seed-env-file` (on top of `SPROUT_SEED_ENV`). Same rule. Repo-relative path only — not a File CI variable ([Troubleshooting](#troubleshooting)). |
| `dotenv_file` | `sprout-preview.env` | Project-root-relative dotenv artifact carrying `PREVIEW_URL` to `environment:url`. Parent directories must already exist (a bare filename always works). |
| `tail` | `200` | Gateway log lines printed when `sprout ci preview` fails. |

Image builds are driven by `.sprout.yaml` (`build.dockerfile`,
`seed.dockerfile` + `seed.env`/`seed.args`); the CLI owns Dockerfile
resolution — the component passes no Dockerfile paths and no free-form
extra args. Gaps belong behind explicit typed inputs (or CLI flags), not
shell guards or argv appenders.

## Troubleshooting

| Symptom | Error (stderr) | Fix |
|---|---|---|
| File-type CI variable passed via `app_env_file` / `seed_env_file` input (e.g. `inputs: { app_env_file: $MY_ENV_FILE }`) | `preview.app_env.<KEY>: required value missing` (nothing points at the input) — had the flag been passed with a bad path, the CLI would say `cannot read --app-env-file: <path>` instead; the required-missing error means the flag never reached the CLI | Never pass file-type variables via `inputs:` — they expand to empty at pipeline-config time and the component's `[ -n "$APP_ENV_FILE" ]` guard skips `--app-env-file` silently. Map the blob at job runtime instead, which the CLI reads automatically: `sprout-preview: { variables: { SPROUT_APP_ENV: $MY_ENV_FILE } }` (seed: `SPROUT_SEED_ENV: $MY_SEED_FILE`). `variables:` merges safely under `extends`; never use job-level `before_script:` here — it replaces the component's CLI install. `app_env_file` / `seed_env_file` are only for repo-relative dotenv paths. |
| Truncated MR description with a reset box | `GitLab MR description is truncated (CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED=true); move the '- [ ] Sprout: reset preview' checkbox and the '<!-- sprout-reset: <token> -->' marker into the first 2700 characters so the reset request is visible` | Paste the snippet at the top of the MR description and retry the job. The tick is never silently ignored. |
| Ticked box does not reset a second time | no error; the run deploys normally | The marker was already handled. Tick the box **and** rotate the token for another reset. |
| Reset while another deploy is in flight | `409 preview_deploy_in_progress` (or `preview_teardown_in_progress`) | Wait for the current run to settle and retry; full rows in [adoption Troubleshooting](../docs/adoption.md#troubleshooting). |

## Remote-include fallback

GitLab resolves `include: component` only on the same instance. Where the
component project is not available, include the tagged file directly (same
content, no shell):

```yaml
include:
  - remote: "https://raw.githubusercontent.com/simpros/sprout/v0.7.0/templates/preview.yml"
    inputs:
      sprout_version: v0.7.0
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
2. The workflow's `component` job copies `templates/preview.yml` to the
   configured GitLab component project, replacing the
   `@SPROUT_COMPONENT_VERSION@` sentinel with the release tag, and tags
   `v<version>` there (`scripts/sync-gitlab-component.sh`). The sync clears `templates/` first, so staging with `git add -A` also removes orphans;
   an existing tag under which new content would land fails the job *before anything is pushed*, so the default branch never advances while `@vX.Y.Z` stays stale. A tag that already points at `HEAD` is success.
3. The pushed tag triggers the component project's own tag pipeline, which
   creates the GitLab Release (catalog version).

Configuration (GitHub repo secrets):

| Secret / var | Purpose |
|---|---|
| `SPROUT_GITLAB_HOST` | GitLab instance FQDN (default `gitlab.com`). Repository variable. |
| `SPROUT_COMPONENT_PROJECT` | Component project path (e.g. `<group>/sprout-ci`). Repository variable. |
| `SPROUT_GITLAB_SYNC_TOKEN` | Token with `write_repository` on the component project. Secret. Unset project ⇒ the job logs a skip and succeeds (forks); set project with missing token ⇒ the job fails. |

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
all three CLI entrypoints, dotenv/`on_stop`/`auto_stop_in` wiring, optional
manual stop (#163), manual reset (`allow_failure`, shared deploy prelude),
dind service,
registry login, checksum verification, YAML-parse of the component plus
shell-syntax check of all four embedded scripts):

- [x] verified via `bun test templates/preview.test.ts`.

Live-instance checks (need a GitLab instance + runner; pending operator):

- [ ] `include: component` + `.sprout.yaml` + two CI variables produces a
  working seeded preview in a test repo, with no adopter shell script.
- [ ] Tagging a sprout release publishes the matching component version
  with no manual step.
- [ ] Remote-include fallback verified once against a tagged raw template.
