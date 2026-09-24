# CI integration

One preview per merge / pull request, driven by CI — no forge webhooks.
GitLab uses the published `preview` component; GitHub uses the reusable
`preview` workflow. Both are thin bootstrappers over `sprout ci preview` /
`sprout ci teardown`: all preview logic lives in the CLI.

- First preview? See [Getting started](getting-started.md).
- Manifest keys? See [Adopting a repo](adopting-a-repo.md).
- Commands reference? See [CLI reference](cli-reference.md).

## GitLab component

`.sprout.yaml` at the repo root (see
[Adopting a repo](adopting-a-repo.md)), two required masked CI variables
(plus optional `GITLAB_TOKEN` for MR notes), and one include. No adopter
shell scripts:

```yaml
# .gitlab-ci.yml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.8.0
    inputs: { stage: deploy }
```

Replace `<group>/sprout-ci` with the component project path on your GitLab
instance and `v0.8.0` with the sprout release you adopt. Where the component
project is unavailable on your instance, use the `include: remote` fallback
documented in [`templates/README.md`](../templates/README.md)
(remote includes must set `sprout_version` explicitly to the tag in the URL).

What you get:

- `sprout-preview` job (merge-request pipelines only): installs the pinned,
  checksum-verified `sprout` binary (version = component version), builds +
  pushes the app image (`CI_REGISTRY_IMAGE:<SHA>`) and — when `.sprout.yaml`
  sets `seed` — the seed image (same repository; commit-scoped
  `<SHA>-seed` tag rebuilt on every run, or — with explicit `seed.inputs` —
  a `seed-<shorthash>` tag content-addressed over those inputs, where an
  authenticated `docker manifest inspect` skips the build + push when that
  tag already exists and logs `seed image reused: <ref>`), deploys, writes `PREVIEW_URL=` to the
  `sprout-preview.env` dotenv artifact that feeds `environment:url`, and
  best-effort posts/updates the MR note with the preview URL (forge failures
  only warn with the forge's error body, never the token). The URL comes from the
  CLI's output only — never reconstruct the hostname in CI.
- `sprout-stop-preview` job (`on_stop`, Stop button / MR close / merge /
  `auto_stop_in` expiry): `sprout ci teardown` (idempotent — exit 0 when
  already gone).
- `sprout-reset` job (manual, instant): `sprout ci reset` — wipe the preview
  database and redeploy + seed from scratch (data wiped). Press **Run** on it
  inside the MR pipeline when you want the reset *now*; ticking the reset box
  in the MR description is the declarative path honored on the next pipeline
  run instead (GitLab has no description-edit → pipeline trigger, and a fresh
  "Run pipeline" arrives as `CI_PIPELINE_SOURCE=web`, which `sprout ci`
  refuses — so the instant path lives inside the existing MR pipeline).
- Prerequisites owned by the component: dind service, registry login,
  `apk` packages. Adopters declare no packages and no Docker setup.

Prerequisites on the GitLab side: merge-request pipelines
(`CI_PIPELINE_SOURCE=merge_request_event`; branch pipelines are refused with
a named error) and a runner that can run privileged `docker:dind`. The
operator must have deployed the [operator compose stack](operator-deploy.md) and
minted the deploy token. Pull credentials on the gateway follow the deploy
`app_image` host (`SPROUT_REGISTRY_AUTHS_JSON` per host, empty = anonymous).

### Component → CLI ownership

The component YAML above calls exactly three `sprout ci` subcommands —
everything else is manual (run from a merge-request pipeline or laptop):

| Component job | CLI call | Owns |
|---|---|---|
| `sprout-preview` | `sprout ci preview --tail … --dotenv-file … [--app-env-file …] [--seed-env-file …] [--reseed]` | Install check aside, the CLI builds + pushes the app image and — when `.sprout.yaml` sets `seed` — the seed image (always rebuilt, unless explicit `seed.inputs` opt into content-addressed reuse: an existing tag skips the rebuild, reuse is logged, a failed check rebuilds), deploys (with `--reseed` when the flag is passed), writes `PREVIEW_URL=` to the dotenv artifact, dumps the gateway log tail on failure, and posts/updates the MR note (best-effort). |
| `sprout-stop-preview` | `sprout ci teardown` (no flags) | Idempotent teardown; rewrites the MR note in place ("preview was removed"). No Docker daemon, no registry login on this path. |
| `sprout-reset` | `sprout ci reset --tail … --dotenv-file … [--app-env-file …] [--seed-env-file …]` | Wipe the preview database and redeploy + seed from scratch (data wiped — the instant path; the ticked box is the declarative path honored on the next pipeline run). No rebuild: reuses the already pushed images for the commit, so no Docker daemon and no registry login on this path. |

Manual helpers (never called by the component): `sprout ci reseed -s …`
(re-run the seed against the existing database) and `sprout ci logs
[--tail N]` (container logs through the gateway). Full flags in
[CLI reference](cli-reference.md#ci-commands).

### Component inputs (`templates/preview.yml`)

Full prose reference: [`templates/README.md`](../templates/README.md).
Contract tests: `templates/preview.test.ts` (inputs are exactly this set —
no Dockerfile guards, no extra-args hatch; self-contained, no
`spec:include`, no global keywords). There are no service-related
component inputs — companions go through `sprout ci preview --service`.

| Input | Default | Purpose |
|---|---|---|
| `sprout_version` | release tag shipping the file (sentinel replaced at publish) | CLI release to install (checksum-verified). Override to pin or trial another build. Remote includes must set it explicitly to the tag in the URL. |
| `stage` | `deploy` | Stage for all three jobs. |
| `sprout_url` | `""` (use `$SPROUT_URL`) | Gateway URL override. |
| `app_context` | `.` | Directory holding `.sprout.yaml`; the CLI builds (`docker build … .`) and resolves Dockerfiles relative to it. |
| `auto_stop_in` | `1 week` | `environment:auto_stop_in` for the preview. |
| `app_env_file` | `""` | Project-root-relative extra dotenv file passed as `--app-env-file` (on top of `SPROUT_APP_ENV`). Resolved before `cd` into `app_context`. Repo-relative path only — not a File CI variable. |
| `seed_env_file` | `""` | Project-root-relative extra seed dotenv file passed as `--seed-env-file` (on top of `SPROUT_SEED_ENV`). Same rule. Repo-relative path only — not a File CI variable. |
| `dotenv_file` | `sprout-preview.env` | Project-root-relative dotenv artifact carrying `PREVIEW_URL` to `environment:url`. Parent directories must already exist. |
| `tail` | `200` | Gateway log lines printed when `sprout ci preview` fails. |

### CI variables (GitLab)

| Variable | Type | Masked | Purpose |
|---|---|---|---|
| `SPROUT_URL` | Variable | yes | Gateway URL (or pass `sprout_url` input instead) |
| `SPROUT_TOKEN` | Variable | yes | Deploy token scoped to the repo's canonical id |
| `SPROUT_APP_ENV` | File | yes | Optional app secrets as one dotenv blob (read automatically by the CLI) |
| `SPROUT_SEED_ENV` | File | yes | Optional seed secrets, same shape |
| `GITLAB_TOKEN` | Variable | yes | Optional MR-note token with note-write. When set, the CLI posts/updates the MR note with it (`PRIVATE-TOKEN`); otherwise it falls back to `CI_JOB_TOKEN` (`JOB-TOKEN`), which can read but not create notes on some instances (401) |

Secrets never appear in job logs, CLI output, or the MR note (the CLI prints only `preview_url=`).

## GitHub Actions

One caller workflow + secrets — parity with the GitLab component. The
**canonical** caller is
[`examples/adopting-repo/.github/workflows/sprout.yml`](../examples/adopting-repo/.github/workflows/sprout.yml)
— copy it rather than pasting fragments from this guide:

```yaml
name: sprout
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, closed]
permissions:
  contents: read
  pull-requests: write
  packages: write
jobs:
  preview:
    uses: simpros/sprout/.github/workflows/preview.yml@v0.8.0
    with:
      sprout_version: v0.8.0
    secrets:
      SPROUT_URL: ${{ secrets.SPROUT_URL }}
      SPROUT_TOKEN: ${{ secrets.SPROUT_TOKEN }}
      SPROUT_APP_ENV: ${{ secrets.SPROUT_APP_ENV }}
```

What you get (owned by the reusable workflow
`.github/workflows/preview.yml`, a thin
bootstrapper over `sprout ci preview` / `sprout ci teardown`):

- Preview on `opened` / `synchronize` / `reopened`: installs the pinned,
  checksum-verified `sprout` binary, builds + pushes images
  (`<registry>/<repo>:<SHA>`, seed image driven by `.sprout.yaml` as on
  GitLab), deploys, and posts/updates the PR comment with the preview URL.
  The URL is also exposed as the `preview_url` output and feeds
  `environment: url`.
- Teardown on `closed`: `sprout ci teardown` (idempotent — exit 0 if
  already gone).
- Reset via the ticked [reset-request checkbox](#reset-request-checkbox):
  `edited` runs a cheap body pre-filter first and skips the preview job
  before checkout when no reset is requested — a title edit never redeploys.
  The pre-filter over-triggers by design (no fence or token validation); the
  reset contract itself is owned by `parseResetRequest` in the CLI, which
  decides reset vs normal deploy on the runs that proceed. A ticked box +
  rotated marker redeploys from scratch on that run. After the reset the job
  rewrites the box back to `- [ ]` while keeping the marker, so the
  follow-up `edited` run exits without resetting.
- Per-PR serial runs via a `sprout-preview-<PR>` concurrency group.

Caller permissions: a reusable workflow cannot elevate permissions, so the
caller must grant `contents: read` (checkout), `pull-requests: write` (PR
comment + the reset untick rewrite), and `packages: write` (image push to
`ghcr.io`).

Secrets (repo settings):

| Secret | Required | Purpose |
|---|---|---|
| `SPROUT_URL` | yes | Gateway URL |
| `SPROUT_TOKEN` | yes | Deploy token scoped to the repo's canonical id |
| `SPROUT_APP_ENV` | no | App secrets as one dotenv blob (GitHub caps secrets at 48 KB) |
| `SPROUT_SEED_ENV` | no | Seed secrets, same shape |

No file-type variables on GitHub: the blobs above are written to
`$RUNNER_TEMP` and read automatically by the CLI. When 48 KB is not enough,
commit a repo-relative dotenv file and pass it via the `app_env_file` /
`seed_env_file` inputs instead of the secret — same escape hatch as the
GitLab `variables:` mapping, without the config-time expansion trap
(inputs are plain paths, never variable references).

Deliberate differences from the GitLab component: there is no `on_stop` /
`auto_stop_in` equivalent — teardown on `closed` plus the gateway sweep is
the safety net, so a long-open PR keeps its preview. Like remote GitLab
includes, the caller pins `sprout_version` explicitly to the tag in the
`uses:` ref (the workflow never derives a version — an empty input fails
fast); no adopter-side version/checksum variables remain. Canonical repo id
is derived from `GITHUB_REPOSITORY` automatically.

### Manual install (laptops, hand-rolled jobs)

Pick the asset that matches the host libc (names are honest):

| Asset | Libc | Use when |
|---|---|---|
| `sprout-linux-x64` | glibc | Debian/Ubuntu runners (GitHub-hosted `ubuntu-*`) |
| `sprout-linux-x64-musl` | musl | Alpine runners; install `libstdc++` |

```bash
TAG=v0.8.0   # pin ≥ the release that ships glibc `sprout-linux-x64`

# glibc hosts
curl -fsSL -o /usr/local/bin/sprout \
  "https://github.com/simpros/sprout/releases/download/${TAG}/sprout-linux-x64"
chmod +x /usr/local/bin/sprout
sprout --version                # must equal $TAG

# musl / Alpine (Bun 1.4.x embeds still need libstdc++ at runtime)
# apk add --no-cache libstdc++   # once on the image
curl -fsSL -o /usr/local/bin/sprout \
  "https://github.com/simpros/sprout/releases/download/${TAG}/sprout-linux-x64-musl"
chmod +x /usr/local/bin/sprout
sprout --version
```

CLI environment for hand-rolled jobs (the reusable workflow sets this itself):

```yaml
env:
  SPROUT_URL: ${{ secrets.SPROUT_URL }}
  SPROUT_TOKEN: ${{ secrets.SPROUT_TOKEN }}
```

## Reset a preview

One command wipes the preview database and redeploys + seeds from scratch:

```bash
sprout ci reset
```

It tears down this MR's preview (container + database), then deploys again
with the already pushed images for the commit — no rebuild — re-running
migrations and the seed behind the health gate, then printing `preview_url=`
like `sprout ci preview`. The MR/PR note gains a `Reset: <actor> at <utc>`
line; the note is never duplicated.

Wipe vs re-seed in one sentence each: `sprout ci reset` wipes the database
and redeploys from scratch (data wiped), while `--reseed` / `sprout ci
reseed -s …` re-runs the seed against the existing database (data kept).

If the reset leaves the preview unhealthy, pull container logs through the
gateway (`sprout ci logs [--tail N]`, same output as `sprout logs`) and fix
forward — app crash-loop (migrations, missing env, wrong port) is the usual
cause; a failed seed keeps the app up and routable with `seeded_at` unset
(see [Troubleshooting](troubleshooting.md)).

### GitLab triggering

GitLab has no "description edited → run a pipeline" trigger, so a ticked
[reset-request checkbox](#reset-request-checkbox) is honored at the **next**
pipeline run, not when it is ticked. Two paths, one operation:

- **Ticked box (declarative):** tick the box and rotate the marker token;
  the next `sprout-preview` run resets first, then deploys normally.
- **Run button (instant):** press **Run** on the `sprout-reset` manual job
  inside the existing MR pipeline — same `sprout ci reset`, same inputs as
  `sprout-preview`, no new commit.

A fresh "Run pipeline" from the GitLab UI cannot be used for the instant
path: it arrives as `CI_PIPELINE_SOURCE=web`, which `sprout ci` refuses by
design (only merge-request pipelines deploy), so the instant path has to be
a job *inside* the existing MR pipeline.

### GitHub triggering

The caller workflow listens to `pull_request: types: [opened, synchronize,
reopened, edited, closed]`. An `edited` run first checks the PR body cheaply
and skips the preview job before checkout when no reset is requested — a
title edit never rebuilds or redeploys. A ticked box plus a rotated marker
token redeploys from scratch on that run. After the reset the job rewrites
the box back to `- [ ]`, keeping the marker, so the `edited` event that
rewrite causes is a no-op. Title edits are deliberately ignored: the reset
contract is owned by `parseResetRequest` in the CLI, not by the event type.

### Reset request checkbox

Tick a box in the MR/PR description and the next `sprout ci preview` run
wipes the preview database and redeploys from scratch — declarative, no
webhook receiver. Snippet (also shipped as
[`templates/reset-request-snippet.md`](../templates/reset-request-snippet.md)):

```markdown
- [ ] Sprout: reset preview <!-- sprout-reset: ada-2026-09-19-1 -->
```

To request a reset, tick the box (`- [x]`) **and** change the marker token to
something new. The token is the exactly-once key: the gateway stores the
handled token on the preview row, so re-runs and pipeline retries deploy
normally. An unticked box, a missing marker, or a tick/marker inside a fenced
code block does nothing. GitHub runs untick the box after the reset (marker
kept); GitLab keeps the tick, guarded by the stored token. Paste the snippet
at the top of the MR/PR description — GitLab exposes only the first 2700
characters to CI, so a truncated description deploys normally with a warning
when no reset box is visible, and deploys first and then fails the job with a
named error when a ticked box is visible but its marker was cut off — the tick
is never silently ignored.

## Migration from a hand-rolled script

If your `.gitlab-ci.yml` currently installs the CLI, builds/pushes images,
and calls `sprout deploy` by hand, replace the whole job with the component.
Hand-rolled setups typically carry `scripts/ci/sprout-preview.sh`
plus a seed-image script, `SPROUT_VERSION` / `SPROUT_SHA256` project
variables, a custom CLI installer block, and flag-by-flag
`--app-env` assembly. Concretely, delete:

1. The `curl` install block (version pin, asset selection, `chmod`,
   `libstdc++` handling) — the component installs the pinned,
   checksum-verified binary matching the component version. This retires the
   custom installer and the `SPROUT_VERSION` / `SPROUT_SHA256` project
   variables: the version is now the component version (`sprout_version`
   input, pinned automatically on component includes).
2. The `docker build` / `docker push` steps and registry-login script — the
   component owns the dind service and login; `sprout ci preview` builds and
   pushes the app image and, when `.sprout.yaml` configures `seed`, the seed
   image. This retires `scripts/ci/sprout-preview.sh` and the seed-image
   script (image coordinates move into `.sprout.yaml` `build` / `seed`
   blocks).
3. The `sprout deploy -i … -s …` invocation, `preview_url=` scraping, dotenv
   writing, and `sprout teardown` script — the component calls
   `sprout ci preview` / `sprout ci teardown`, writes the dotenv artifact,
   and posts the MR note. Flag-by-flag `--app-env` assembly in shell goes
   away with it: extra env moves into `.sprout.yaml` (`preview.app_env` /
   `seed.env`), the `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` file-type variables,
   or the `app_env_file` / `seed_env_file` component inputs.
4. Any reconstruction of the preview hostname in CI (string munging
   `pr-<id>.host`) — read `PREVIEW_URL` / `preview_url=` from the CLI output
   instead.

After the migration no adopter shell script remains: the component declares
all three jobs (`sprout-preview`, `sprout-stop-preview`, `sprout-reset`), and
every behavior the old script hand-built (install, build/push, deploy,
dotenv, MR note, log dump on failure) is owned by `sprout ci preview` /
`sprout ci teardown`. The `.sprout.yaml` `seed:` block replaces the `-s`
plumbing: when present, the CLI builds + pushes the seed image and deploys
with it; the hand-written `-s` flag disappears from CI entirely.

## See also

- [Getting started](getting-started.md) — first preview
- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [Previews](previews.md) — databases, seeding, services, mail
- [CLI reference](cli-reference.md) — command flags
- [Troubleshooting](troubleshooting.md) — error catalogue
