# Adopting repo guide

The one-include flow: one component include, one `.sprout.yaml`, two required CI
variables (plus optional `GITLAB_TOKEN` for MR notes) — a working seeded
preview with no adopter shell scripts. CI never
touches Postgres admin credentials.

- New adopter? Read [Quickstart](#quickstart-gitlab-component) only.
- Need an exact key or flag? See [Reference](#reference).
- On a hand-rolled `curl` / `docker build` / `sprout deploy` script? See
  [Migration](#migration-from-a-hand-rolled-script).
- Red pipeline? See [Troubleshooting](#troubleshooting).

Copy-paste app files (`.sprout.yaml`, `.gitlab-ci.yml`, Dockerfiles,
entrypoints, seed script) live in
[`examples/adopting-repo/README.md`](../examples/adopting-repo/README.md).

## Quickstart (GitLab component)

Three artifacts, nothing else. Takes a repo with a `Dockerfile` and a
`Dockerfile.seed` to a seeded preview on every merge request.

**1. `.sprout.yaml` at the repo root** — seeded preview (health block is
required whenever `seed` is configured):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: demo
```

Omit the `seed:` block for an app-only preview (the `health:` block can go
too — the gateway defaults to `GET /health` every `2s` for up to `120s`,
expecting `200`).

**2. CI variables** (project or group settings; full variable
reference, including file-type blobs and the `GITLAB_TOKEN` fallback, in
[`templates/README.md`](../templates/README.md)):

| Variable | Type | Purpose |
|---|---|---|
| `SPROUT_URL` | Variable, masked, required | Gateway URL (or pass the `sprout_url` input instead) |
| `SPROUT_TOKEN` | Variable, masked, required | Deploy token scoped to the repo's canonical id (see [Deploy token setup](#deploy-token-setup)) |
| `GITLAB_TOKEN` | Variable, masked, optional | Note-write token (e.g. a project access token) for the MR note. Without it the CLI falls back to `CI_JOB_TOKEN`, which can read but not create notes on some instances (401) — the note is best-effort either way |

Optional: `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` as masked **File** variables
holding dotenv blobs for app / seed secrets (see
[Extra app env](#extra-app-env-non-connection)). The CLI reads the file path
from the variable automatically.

**3. `.gitlab-ci.yml`** — one include, no scripts:

```yaml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.6.0
    inputs: { stage: deploy }
```

Replace `<group>/sprout-ci` with the component project path on your GitLab
instance and `v0.6.0` with the sprout release you adopt. Where the component
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
- Prerequisites owned by the component: dind service, registry login,
  `apk` packages. Adopters declare no packages and no Docker setup.

Prerequisites on the GitLab side: merge-request pipelines
(`CI_PIPELINE_SOURCE=merge_request_event`; branch pipelines are refused with
a named error) and a runner that can run privileged `docker:dind`. The
operator must have deployed the [operator compose stack](deploy.md) and
minted the deploy token. Pull credentials on the gateway follow the deploy
`app_image` host (`SPROUT_REGISTRY_AUTHS_JSON` per host, empty = anonymous).

### Component → CLI ownership

The component YAML above calls exactly two `sprout ci` subcommands —
everything else is manual (run from a merge-request pipeline or laptop):

| Component job | CLI call | Owns |
|---|---|---|
| `sprout-preview` | `sprout ci preview --tail … --dotenv-file … [--app-env-file …] [--seed-env-file …] [--reseed]` | Install check aside, the CLI builds + pushes the app image and — when `.sprout.yaml` sets `seed` — the seed image (always rebuilt, unless explicit `seed.inputs` opt into content-addressed reuse: an existing tag skips the rebuild, reuse is logged, a failed check rebuilds), deploys (with `--reseed` when the flag is passed), writes `PREVIEW_URL=` to the dotenv artifact, dumps the gateway log tail on failure, and posts/updates the MR note (best-effort). |
| `sprout-stop-preview` | `sprout ci teardown` (no flags) | Idempotent teardown; rewrites the MR note in place ("preview was removed"). No Docker daemon, no registry login on this path. |

Manual helpers (never called by the component): `sprout ci reseed -s …`
(re-run the seed against the existing database) and `sprout ci logs
[--tail N]` (container logs through the gateway). Full flags in
[CLI `ci` commands](#cli-ci-commands).

## Reference

### Manifest keys (`.sprout.yaml`)

The CLI reads this file locally and sends parsed values to the gateway.
Unknown keys are rejected (`unknown key: <path>`). This table is the
contract; the notes directly below it (connection env, value grammar, merge
order, service images, seed run order) are part of the
contract. The later sections (App image, After-healthy, Multi-image,
Debugging, CI workflow) are examples and flow notes only. Test
pointers live in [Test coverage](#test-coverage-maintainers).

| Key | Required | Default | Purpose |
|---|---|---|---|
| `slug` | yes | — | Short name used in database names (`sprout_<slug>_pr<id>`) and container names. Alphanumeric. |
| `preview.hostname` | yes | — | Per-PR host template. Must contain `{pr_id}`; no scheme, port, path, or other placeholders. The CLI owns substitution and prints `preview_url=` — CI never reconstructs it. |
| `preview.env` | no | canonical `PG*` / `PGAPP*` (`postgres`) or `DATABASE_URL` (`sqlite`); rejected on `none` | Rename injected connection env (see Connection env). |
| `preview.app_env` | no | — | Extra app env (see Value grammar, Merge order, Connection env reservation). |
| `preview.services` | no | leave companions | Companion routing entries (see Service images). |
| `preview.services[].name` | per entry | — | Service name (validated, unique). |
| `preview.services[].image` | per entry unless `--service` | — | Pinned image for the service. |
| `preview.services[].hostname` | no | internal-only | Distinct `Host()` for the service. |
| `preview.services[].path` | no | internal-only | `PathPrefix()` for the service (must start with `/`). |
| `db.provider` | no | `postgres` | Preview database provider: `postgres` (shared instance), `sqlite` (named volume), or `none` (no database). See [SQLite previews](#sqlite-previews) and [No-database previews](#no-database-previews). |
| `db.path` | no | `/data` | Container directory the SQLite volume mounts at (`sqlite` only). |
| `db.file` | no | `preview.db` | SQLite file name inside `db.path` (`sqlite` only). |
| `health.path` | when seeding | `/health` | HTTP path the gateway polls on the Postgres-network container IP. |
| `health.interval` | when seeding | `2s` | Poll interval (`Ns` form; malformed durations fail at manifest parse). |
| `health.timeout` | when seeding | `120s` | How long the gateway polls before `health_timeout`. Never starts the seed. |
| `health.expect` | when seeding | `200` | Expected status (100–599). Gates the after-healthy seed hook. |
| `build.dockerfile` | no | `Dockerfile` | App Dockerfile for `sprout ci preview`. An empty `build: {}` takes the default. |
| `seed.dockerfile` | when `seed:` present | `Dockerfile.seed` | Seed Dockerfile. An empty `seed: {}` takes the default and enables seeding. |
| `seed.inputs` | no | — (always rebuild) | Repo-relative paths whose contents key seed-image reuse (seed Dockerfile, entrypoint/script, migrations, lockfile, …). Sorted with paths folded into a sha256; the seed tag is `<registry-path>:seed-<12-hex>`. Without `inputs` the tag is commit-scoped (`<SHA>-seed`) and the seed image is rebuilt on every run — set `inputs` explicitly to opt into reuse, listing every COPY source the seed image depends on. |
| `seed.env` | no | — | Seed-only env (same grammar and layering as `preview.app_env`). |
| `seed.args` | no | — | Seed container args (yaml first, then `--seed-arg` flags appended). |

#### Connection env: names, roles, reservation, port

The gateway injects these connection variables into preview app, service,
and seed containers. Which set you get follows `db.provider`:

Postgres (`db.provider: postgres`, the default):

```
PGHOST  PGPORT  PGUSER  PGPASSWORD  PGDATABASE
PGAPPUSER  PGAPPPASSWORD
```

SQLite (`db.provider: sqlite`):

```
DATABASE_URL=file:<db.path>/<db.file>   (default file:/data/preview.db)
```

No-database (`db.provider: none`): no connection variables are injected
at all — every `preview.env` entry is rejected at manifest parse
(`preview.env.PGHOST requires db.provider postgres`) and at the gateway
deploy route, and a `seed:` block is rejected the same way
(`seed requires db.provider postgres or sqlite (db.provider is none)`).
See [No-database previews](#no-database-previews) for the lifecycle.

No `PG*` keys are injected for a SQLite preview, and no `DATABASE_URL`
for a Postgres one — `preview.env` entries for the other backend fail at
manifest parse (`preview.env.PGHOST requires db.provider postgres`).
See [SQLite previews](#sqlite-previews) for the volume behaviour.

- **Owner** (`PGUSER` / `PGPASSWORD`): the static preview login
  (`SPROUT_PG_USER`). Owns each preview database — use this for migrations.
- **Restricted companion** (`PGAPPUSER` / `PGAPPPASSWORD`): a per-preview
  LOGIN named `<dbName>_app` with `CONNECT` and schema `USAGE` only.
  Password is derived by the gateway (stable for the life of the preview).
  Use this for RLS-constrained runtime queries. Do not `CREATE ROLE` — the
  gateway already provisioned it; `GRANT` table privileges to this role
  instead.

`preview.env` renames the gateway-injected connection names. Unmapped keys
stay canonical; a remap replaces the name (no dual alias). The entrypoint
must read the adopter names.

Gateway connection keys replace colliding adopter keys (canonical `PG*` ∪
remapped names after `preview.env`) — same policy for app and seed env
(see `apps/server/src/app-deployment/pg-env.ts`). Do not put `PGHOST` or a
remapped name into `SPROUT_APP_ENV`: the gateway strips it in favour of
its own value and the app silently gets the gateway's connection, not
yours.

Port: the gateway routes to the first `EXPOSE`d port in the app image,
else `SPROUT_PREVIEW_PORT_DEFAULT`. Teardown drops the database and then
the companion role.

#### Env value grammar

`preview.app_env` / `seed.env` values are a plain string, `{ generate:
stable_per_pr }`, or `{ required: true }`. Strings may interpolate
`{hostname}`, `{pr_id}`, `{commit_sha}` (`{commit_sha}` follows the forge
SHA, `CI_COMMIT_SHA` on GitLab / `GITHUB_SHA` on GitHub). `generate`
derives a per-MR secret (HMAC of repo, MR, key, keyed by the deploy token
— keep the token stable for the MR lifetime). `required` must be supplied
by CI; missing keys fail before the gateway call naming the key.

#### Env merge order

App: yaml first, then `SPROUT_APP_ENV` / each `--app-env-file` in order,
then `--app-env` flags (later wins per key). Seed: yaml first, then
`SPROUT_SEED_ENV` / each `--seed-env-file` in order, then `--seed-env`
flags. Seed args: yaml `seed.args` first, then `--seed-arg` flags
appended.

#### Service images: merge, leave, clear, lifecycle

Static `image` in yaml pins the image; `--service name=image` overlays it
— every service needs an image after merge. Omitting `--service` leaves
companions in place; `--clear-services` removes all (cannot combine with
`--service`). An empty list is rejected (omit the key, or
`--clear-services`). Reseed bodies carry no service list, so companions
stay as last deployed by construction.

Each service joins the same networks as the app (Traefik + Postgres for
`postgres` previews, Traefik only for `sqlite` and `none`) and receives
the **same connection env** as the app (including any
`preview.env` remap; `none` previews inject no connection env at all).
Services are force-removed on **teardown** (and on
replace) with the app. The health gate covers **only the app**: after the
app passes `health.expect`, seed runs (when configured), then companion
services start. There is no per-service health poll in this release.

#### Seed run order and resume

1. App container starts (entrypoint waits for Postgres, runs migrations, serves).
2. Gateway polls `health.path` on the Postgres-network container IP until
   `health.expect` or `health.timeout`.
3. **After healthy:** if a seed image was provided and this PR has never
   seeded successfully (`seeded_at` unset), or the incoming seed image
   differs from the last successful one, the gateway runs the seed image
   once with the same connection-env remap as the app, plus `seed.env` /
   `--seed-env` and `seed.args` / `--seed-arg`. `--reseed` clears
   `seeded_at` after a healthy attach (replace) or on seed-phase entry
   (seed-only), so the same after-healthy gate re-runs even when the
   seed image is unchanged.
4. Preview status becomes `running` with `seeded_at` set.

On later synchronize deploys, seeding is skipped only when the incoming
seed image matches the last successful one. Same image + hostname:
seed-only (no app container replace). A changed seed image alone re-runs
the seed without replacing the app container. Image or hostname change
still replaces the app, then runs seed after
healthy when `seeded_at` is unset, the seed image changed, or `--reseed`
was passed. Seed
wall-clock is the gateway env `SPROUT_SEED_TIMEOUT` (seconds, default
`180`, applied internally as `seedTimeoutMs`); health timeout is separate
and never starts the seed. Seed failure outcomes (exit non-zero, timeout,
Docker/ops error → `500 seed_failed`, app stays up and routable,
`seeded_at` unset; health timeout → `health_timeout`, app removed, seed
never started) and the resume rule (failed/crash-mid-seed with same image
+ hostname: redeploy with `-s` resumes the seed only; without
`seed_image`, resume returns `422
seed_image_required_to_resume_seeding`) are covered under
[Troubleshooting](#troubleshooting).

Minimal app-only manifest (defaults apply):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

Seeded manifest (as in the quickstart): add `health:` + `seed:` as shown
above. `seed: {}` alone enables seeding with the conventional
`Dockerfile.seed`.

### SQLite previews

For stacks that run on SQLite instead of Postgres, set `db.provider` —
`sprout ci preview` picks it up from `.sprout.yaml` (no new flag):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  env:
    DATABASE_URL: APP_DATABASE_URL
db:
  provider: sqlite
  path: /data
  file: preview.db
```

Env keys: the gateway injects exactly one connection variable,
`DATABASE_URL=file:<db.path>/<db.file>` (remap replaces the name, no
dual alias). `PG*` remaps are rejected for SQLite previews, and
`DATABASE_URL` is rejected for Postgres ones — both at manifest parse
and at the gateway deploy route.

Volume and seed behaviour: bring-up creates one named Docker volume per
preview (`sprout-<slug>-pr-<id>-sqlite`) mounted at `db.path` in the
app, companion-service, and seed containers (seed inputs still own the
fixtures; `--reseed` semantics are unchanged). An app-image replace
keeps the volume, so preview data survives; teardown removes the
containers and the volume on the same paths that drop a Postgres
database today. Health, TTL, sweep, and teardown are otherwise unchanged.

Hand-rolled migration notes (moving an app from a Postgres preview to a
SQLite one): point the app at the injected `DATABASE_URL` instead of the
`PG*` set (SQLite opens the file directly — no host, port, user, or
password); run file-level migrations at container startup as before (the
file persists on the volume across replaces); keep companion `PGAPP*`
assumptions out of the SQLite path (there is no restricted role — the
file is the database). There is no gateway tooling that copies a
Postgres preview into a SQLite volume in this release.

Operators: a gateway that only serves SQLite previews needs no Postgres
env at all (`SPROUT_PREVIEW_POSTGRES_URL`, `SPROUT_PG_HOST/USER/PASSWORD`,
`SPROUT_POSTGRES_NETWORK` are required only for `postgres` deploys). A
`postgres` deploy on such a gateway fails fast with
`postgres_not_configured`, naming the repo and the missing variables.

### No-database previews

For apps with no database — static or SSR frontends, apps whose data
lives behind an external API, worker-only services — set `db.provider` to
`none`. `sprout ci preview` picks it up from `.sprout.yaml` (no new flag):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
db:
  provider: none
```

The preview is app container + optional companion services + routing +
health, with no database at all: bring-up provisions nothing and injects
no connection env, teardown removes only containers, and the status and
`previews` rows carry `db_name: null`. Companion services keep working
exactly as today minus the database env (Traefik network only, no
`PG*` / `DATABASE_URL` keys).

Two combinations are validation errors rather than silent no-ops, both at
manifest parse and at the gateway deploy route: a `seed:` block (`seed
requires db.provider postgres or sqlite (db.provider is none)`) and any
`preview.env` database-key remap (`preview.env.PGHOST requires
db.provider postgres`). `sprout ci reseed`, `sprout deploy -s …`, and
`--reseed` fail fast with the seed error on a `none` repo instead of a
5xx.

Operators: a gateway whose repos are all `none` boots with no
`SPROUT_*PG*` / `SPROUT_POSTGRES_NETWORK` set; with any `postgres` repo
onboarded it still fails fast when they are missing (same conditional
requirement as SQLite). Switching a repo between `none` and a database
provider redeploys as a fresh generation: the old backend is dropped
before the row is rewritten, so no resource strands.

### CLI `ci` commands

`usage: sprout ci <preview|teardown|reseed|logs> …` — repo, MR id, and
pipeline source are inferred from CI env (`CI_PROJECT_URL` /
`CI_MERGE_REQUEST_IID` / `CI_PIPELINE_SOURCE` on GitLab;
`GITHUB_REPOSITORY` + event payload on GitHub). Identity resolves before
auth so outside-pipeline errors win over missing-token. This table is the
contract; test pointers live in [Test coverage](#test-coverage-maintainers).

| Command | Flags | Purpose |
|---|---|---|
| `sprout ci preview` | `--app-env KEY=VALUE` (repeat) | One-off app env (highest precedence). |
| | `--app-env-file PATH` (repeat) | Explicit dotenv file(s) for the app, on top of `SPROUT_APP_ENV`. |
| | `--seed-env KEY=VALUE` (repeat) | One-off seed env. |
| | `--seed-env-file PATH` (repeat) | Explicit dotenv file(s) for the seed, on top of `SPROUT_SEED_ENV`. |
| | `--seed-arg ARG` (repeat) | Extra seed container args (appended after yaml `seed.args`; values may start with `-`). |
| | `--service name=image` (repeat) | Create/refresh companion services (see [Multi-image previews](#multi-image-previews-app--services)). |
| | `--clear-services` | Remove all companions (`services: []` on the API). Cannot combine with `--service`. |
| | `--tail N` | Gateway log lines printed when the deploy fails (default `200`; must be a positive integer, checked before building). |
| | `--dotenv-file PATH` | Dotenv artifact the CLI writes `PREVIEW_URL=` to (default `sprout-preview.env`, relative to the workspace root). Emitted only once the preview is healthy. |
| | `--reseed` | Force the gateway to re-run the seed against the existing database (requires a `seed` block) — re-seeds even when the seed image is unchanged. A changed seed image already re-seeds automatically; without seed changes, omit it — a reused image still seeds every fresh PR (`seeded_at` unset). |
| `sprout ci teardown` | *(no flags — extra args are rejected)* | Tear down this MR's preview. Idempotent; rewrites the MR note in place ("preview was removed"). Note failures only warn so gateway success owns the exit code. |
| `sprout ci reseed` | `-s <seed-image>` (required) | Re-run the seed job against the existing database (no image build; app tag from `CI_REGISTRY_IMAGE` + SHA). Body is a reseed request, so companions stay as last deployed by construction. |
| | `--seed-env`, `--seed-env-file`, `--seed-arg`, `--app-env`, `--app-env-file` | Same env layering as `preview` (yaml + blob + files + flags). |
| `sprout ci logs` | `--tail N` | Preview container logs through the gateway (app, then seed when available). |

On success `sprout ci preview` prints `preview_url=` to stdout (and writes
the dotenv file); on failure it prints the gateway log tail first, then the
deploy error exits non-zero. The MR note is best-effort in both directions
(forge failures warn with the forge's error body, never the token).

Low-level equivalents (`sprout deploy -i … -s …`, `sprout teardown`,
`sprout logs`) still work for GitHub Actions and laptops — see
[CI workflow (GitHub Actions)](#ci-workflow-github-actions) and
[Debugging](#debugging). Their env/seed/service flags mirror the `ci`
surface (`-i`, `-s`, `--reseed`, `--service`, `--clear-services`,
`--app-env[-file]`, `--seed-env[-file]`, `--seed-arg`).

### Component inputs (`templates/preview.yml`)

Full prose reference: [`templates/README.md`](../templates/README.md).
Contract tests: `templates/preview.test.ts` (inputs are exactly this set —
no Dockerfile guards, no extra-args hatch; self-contained, no
`spec:include`, no global keywords). There are no service-related
component inputs — companions go through `sprout ci preview --service`.

| Input | Default | Purpose |
|---|---|---|
| `sprout_version` | release tag shipping the file (sentinel replaced at publish) | CLI release to install (checksum-verified). Override to pin or trial another build. Remote includes must set it explicitly to the tag in the URL. |
| `stage` | `deploy` | Stage for both jobs. |
| `sprout_url` | `""` (use `$SPROUT_URL`) | Gateway URL override. |
| `app_context` | `.` | Directory holding `.sprout.yaml`; the CLI builds (`docker build … .`) and resolves Dockerfiles relative to it. |
| `auto_stop_in` | `1 week` | `environment:auto_stop_in` for the preview. |
| `app_env_file` | `""` | Project-root-relative extra dotenv file passed as `--app-env-file` (on top of `SPROUT_APP_ENV`). Resolved before `cd` into `app_context`. Repo-relative path only — not a File CI variable (see [component Troubleshooting](../templates/README.md#troubleshooting)). |
| `seed_env_file` | `""` | Project-root-relative extra seed dotenv file passed as `--seed-env-file` (on top of `SPROUT_SEED_ENV`). Same rule. Repo-relative path only — not a File CI variable (see [component Troubleshooting](../templates/README.md#troubleshooting)). |
| `dotenv_file` | `sprout-preview.env` | Project-root-relative dotenv artifact carrying `PREVIEW_URL` to `environment:url`. Parent directories must already exist. |
| `tail` | `200` | Gateway log lines printed when `sprout ci preview` fails. |

## Migration from a hand-rolled script

If your `.gitlab-ci.yml` currently installs the CLI, builds/pushes images,
and calls `sprout deploy` by hand, replace the whole job with the component.
Hand-rolled setups (per #118) typically carry `scripts/ci/sprout-preview.sh`
plus a seed-image script, `SPROUT_VERSION` / `SPROUT_SHA256` (or `SPROUT_SHA`)
project variables, a custom CLI installer block, and flag-by-flag
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

Worked diff (GitLab, seeded preview). Before (hand-rolled shape that
actually feeds `environment:url` from the CLI output):

```yaml
preview:
  image: docker:24
  services: [{ name: docker:24-dind, alias: docker }]
  variables: { DOCKER_HOST: tcp://docker:2375, DOCKER_TLS_CERTDIR: "" }
  script:
    - apk add --no-cache curl ca-certificates libstdc++
    - curl -fsSL -o /usr/local/bin/sprout "https://github.com/simpros/sprout/releases/download/v0.6.0/sprout-linux-x64-musl"
    - chmod +x /usr/local/bin/sprout
    - echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin
    - docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
    - docker build -f Dockerfile.seed -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-seed" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-seed"
    - sprout deploy -i "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" -s "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA-seed" | tee deploy.log
    - PREVIEW_URL="$(grep -o 'preview_url=.*' deploy.log | cut -d= -f2-)"
    - echo "PREVIEW_URL=${PREVIEW_URL}" > sprout-preview.env
  artifacts:
    reports: { dotenv: sprout-preview.env }
  environment:
    name: preview/mr-$CI_MERGE_REQUEST_IID
    url: $PREVIEW_URL
    on_stop: stop-preview

stop-preview:
  image: docker:24
  script:
    - apk add --no-cache curl ca-certificates libstdc++
    - curl -fsSL -o /usr/local/bin/sprout "https://github.com/simpros/sprout/releases/download/v0.6.0/sprout-linux-x64-musl"
    - chmod +x /usr/local/bin/sprout
    - sprout teardown
  environment:
    name: preview/mr-$CI_MERGE_REQUEST_IID
    action: stop
```

After (image coordinates move into `.sprout.yaml`; CI keeps only the
include). `.sprout.yaml`:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
seed:
  dockerfile: Dockerfile.seed
  env:
    FIXTURE_SET: demo
```

`.gitlab-ci.yml`:

```yaml
include:
  - component: $CI_SERVER_FQDN/<group>/sprout-ci/preview@v0.6.0
    inputs: { stage: deploy }
```

After the migration no adopter shell script remains: the component declares
both jobs (`sprout-preview`, `sprout-stop-preview`), and every behavior the
old script hand-built (install, build/push, deploy, dotenv, MR note, log
dump on failure) is owned by `sprout ci preview` / `sprout ci teardown`.
The `.sprout.yaml` `seed:` block replaces the `-s` plumbing: when present,
the CLI builds + pushes the seed image and deploys with it; the hand-written
`-s` flag disappears from CI entirely.

## Troubleshooting

Every entry names the exact CLI error. None of these print env values —
parse errors name the key or file without echoing the value.

| Symptom | Error (stderr) | Fix |
|---|---|---|
| Job runs on a branch pipeline, not an MR | `sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=…); run from a merge-request pipeline` (GitHub: `GITHUB_EVENT_NAME=…`) | Gate the jobs on `$CI_MERGE_REQUEST_IID` (the component does this) or run from a `pull_request` workflow. Running both forges' claims at once is refused as ambiguous. |
| Registry/SHA missing so the image tag cannot be built | `cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA)` | Run on a runner with the container registry enabled; on GitLab the component logs in with `CI_REGISTRY_USER`/`CI_REGISTRY_PASSWORD` automatically. |
| Remote include without a version | `sprout_version input is empty/unpinned (remote includes must set sprout_version explicitly …)` | Set `sprout_version` to the tag in the `remote:` URL. Component includes pin it automatically. |
| Downloaded release fails verification | `checksum entry missing for <asset> in <tag>/SHA256SUMS.txt …` or a `sha256sum -c` mismatch; `test "$(sprout --version)" = "…"` fails | Pin to a release that ships checksums (≥ the release that publishes `SHA256SUMS.txt`); do not hand-edit the install — the component verifies the downloaded asset. |
| Hostname template rejected | `preview.hostname … must contain {pr_id}` / scheme/port/path/placeholder errors; service `preview.services[i].hostname` / `.path must start with /` | Keep the template a bare host with `{pr_id}` (`pr-{pr_id}.app.example.com`). Read the URL from `preview_url=` / `PREVIEW_URL` — never reconstruct it in CI. |
| Unknown manifest key | `unknown key: <path>` (top-level, `preview.*`, `health.*`, `seed.*`, `preview.env.*`) | Rename to a key in the [manifest table](#manifest-keys-sproutyaml); check `preview.env` against the canonical `PG*` set and services against `name/image/hostname/path`. |
| Seed configured without health | `health block required in .sprout.yaml when seed block is configured` (or `when -s is passed`) | Add the `health:` block (quickstart snippet). The gate runs before any `docker build`. |
| Secret not supplied | deploy fails before the gateway call naming the key (declared `{ required: true }`, no file/flag provided it) | Provide it via the `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` file-type variable or `--app-env[-file]` / `--seed-env[-file]`. Never commit the secret to the manifest. |
| File-type CI variable passed via `app_env_file` / `seed_env_file` input (e.g. `inputs: { app_env_file: $MY_ENV_FILE }`) | `preview.app_env.<KEY>: required value missing` (nothing points at the input) — had the flag been passed with a bad path, the CLI would say `cannot read --app-env-file: <path>` instead | Repo-relative dotenv paths only — never pass File vars via `inputs:`; map the blob at job runtime via `variables:` (`sprout-preview: { variables: { SPROUT_APP_ENV: $MY_ENV_FILE } }`, seed: `SPROUT_SEED_ENV: $MY_SEED_FILE`). Full diagnostic in [component Troubleshooting](../templates/README.md#troubleshooting). |
| Invalid dotenv line or flag | names the offending key or file, value never echoed | Fix the `KEY=value` line (blank lines, `#` comments, optional `export ` prefix; values may contain `=`); check `--tail` is a positive integer (`--tail must be a positive integer`). |
| Deploy never becomes healthy | `health_timeout` (gateway log tail printed first), `deploy_timeout` on poll expiry | Pull `sprout logs <mr_id> --tail 200`: app crash-loop (migrations, missing env, wrong port) is the usual cause. Reviewers may see brief 502s while the app migrates — Traefik routes exist before the app is healthy. |
| Seed fails | `seed_failed` (exit code or `timeout` in `last_error_detail`); app **stays up** and routable, `seeded_at` unset | Fix the seed image and redeploy with `-s` (resume path — no Traefik replace when image + hostname are unchanged). Seed wall-clock is `SPROUT_SEED_TIMEOUT` (default `180s`); health timeout is separate and never starts the seed. |
| Redeploy after a failed seed without `-s` | `422 seed_image_required_to_resume_seeding` | Redeploy with `-s` (resume needs the seed image); `--reseed` is not required for first-seed failure resume. Tear down only for a fresh database, not fresh fixtures. |
| Synchronize deploy skips seeding | no error; incoming seed image matches the last successful one | Pass `--reseed` with `-s` (or `sprout ci reseed -s …`) to force a re-seed against the existing database. A failed reseed clears `seeded_at` and keeps the app up, leaving the stored seed image unchanged so the next deploy retries. |
| Seed inputs changed but fixtures look stale | job log shows a new `seed-<shorthash>` tag built, yet no seed run | The gateway re-runs the seed automatically when the incoming seed image differs from the last successful one — no `--reseed` needed. If fixtures still look stale, check the seed job logs (`sprout ci logs`) for a `seed_failed` outcome. See [After-healthy hook](#after-healthy-hook-seed-image). |
| `sprout ci reseed` without an image | `ci reseed requires -s <seed-image>` | Pass `-s` with the seed image; reseed runs against the existing database without rebuilding. |
| `seed:` block with `db.provider: none` | `seed requires db.provider postgres or sqlite (db.provider is none)` (manifest parse and `422 seed_requires_database` at the deploy route) | Remove the `seed:` block — a no-database preview has nothing to seed. If the app needs fixtures, it is not a `none` repo; use `postgres` or `sqlite`. |
| `-s` / `--reseed` / `sprout ci reseed -s …` on a `none` repo | `seed requires db.provider postgres or sqlite (db.provider is none)` (`422 seed_requires_database` from the gateway) | Drop the seed flags — there is no database to re-seed. The CLI fails before any network call; the gateway agrees on the message. |
| `preview.env` database key with `db.provider: none` | `preview.env.<KEY> requires db.provider <postgres\|sqlite>` (manifest parse and `422 invalid_env_for_provider` at the deploy route) | Remove the entry — `none` previews inject no connection env. Keep only `preview.app_env` / `--app-env` for non-connection values. |

## App image: migrate at startup

Reference above is the contract; this section is entrypoint examples only.
Connection names, owner/companion roles, and the port rule live in
[Reference](#reference) (Connection env) — snippets below assume the
default `PG*` / `PGAPP*` map.

Your app image must:

1. Wait until Postgres accepts connections.
2. Run migrations as the **owner** against the injected database name
   (default `PGDATABASE`); `GRANT` to the companion role for RLS instead
   of creating roles.
3. Start the web server, connecting runtime queries as `PGAPPUSER` when
   you need RLS.

There is **no mandatory wrapper image** from sprout. Copy an entrypoint
that fits your stack.

### Dual-role (RLS) previews

Product databases that use a privileged owner + restricted RLS role work on
previews without cluster `CREATEROLE` on the preview login:

1. Migrate with `PGUSER` / `PGPASSWORD` (owner).
2. `GRANT` the needed table/sequence privileges to the role in `PGAPPUSER`
   (and enable RLS / policies as in production).
3. Open the app pool with `PGAPPUSER` / `PGAPPPASSWORD` (remap via
   `preview.env` if that matches your product env names — see
   [Reference](#reference), Connection env).

### Extra app env (non-connection)

Example only — grammar, merge order, and the gateway reservation rule
(Connection env) live in the [Reference](#reference). Adopters often need runtime env beyond the
connection fields (`BETTER_AUTH_SECRET`, app URLs, trusted origins, etc.):
pass those as `preview.app_env` / `seed.env` in `.sprout.yaml`, a masked
file-type `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` dotenv blob, repeatable
`--app-env-file` / `--seed-env-file`, or repeatable `--app-env KEY=VALUE` /
`--seed-env KEY=VALUE`. Forge File-var wiring lives in
[`templates/README.md`](../templates/README.md); placeholders expand in
every layer (see the [Reference](#reference)). File-type CI variables do NOT
survive component `inputs:` expansion — map file-type blobs at job runtime
via `variables:` (`SPROUT_APP_ENV: $MY_ENV_FILE`), never as `app_env_file:`
inputs (details in
[`templates/README.md`](../templates/README.md#troubleshooting)).

Example:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  app_env:
    LOG_LEVEL: info
    BETTER_AUTH_URL: "https://{hostname}"
    BETTER_AUTH_SECRET:
      generate: stable_per_pr
    STRIPE_API_KEY:
      required: true
```

Placeholders expand in every layer — see the [Reference](#reference).

### Shell entrypoint (any runtime)

See [`examples/adopting-repo/docker-entrypoint.sh`](../examples/adopting-repo/docker-entrypoint.sh)
(default `PG*` names):

```bash
#!/bin/sh
set -eu
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE"; do
  sleep 1
done
./migrate.sh   # your toolchain: drizzle-kit, prisma, flyway, etc.
exec "$@"
```

### Bun / Node one-liner variant

```bash
until bun -e "await Bun.sql\`select 1\`"; do sleep 1; done
bun run db:migrate
exec bun run start
```

Migrations must be **idempotent** — synchronize re-deploys keep the same
database and re-run migrate on every container start.

## After-healthy hook (seed image)

Run-order flow and low-level examples only — ordering, resume, timeout, and
failure outcomes are contract in the [Reference](#reference) (seed run order)
and [Troubleshooting](#troubleshooting) (seed failure rows).

The gateway's only post-startup timing hook is **after-healthy**: once the
preview app passes `health.expect`, an optional **seed image** runs. That is
how you sequence "migrate in the app, then seed" with zero API-code changes —
no `wait-for-postgres` / sleep loops in the seed path to wait for migrations.

With the component you declare it once in `.sprout.yaml` (quickstart) and
never pass `-s` in CI — `sprout ci preview` builds + pushes the seed image
and deploys with it. Without `seed.inputs` the tag is commit-scoped
(`<SHA>-seed`) and the image is rebuilt on every run; with explicit
`seed.inputs` the tag is `seed-<shorthash>` content-addressed over those
inputs (list every COPY source the seed image depends on). When the
content-addressed tag already exists in the
registry the build + push is skipped (`seed image reused: <ref>` in the job
log) and the existing image deploys; a failed or unsupported registry check
rebuilds instead of skipping. The low-level equivalent is
`sprout deploy -i … -s …` with
`--seed-env` / `--seed-arg`:

```bash
sprout deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" \
  --seed-env FIXTURE_SET=demo \
  --seed-arg --reset
```

[`examples/adopting-repo/Dockerfile.seed`](../examples/adopting-repo/Dockerfile.seed)
shows a minimal seed image: install deps, copy seed script, entrypoint runs
`bun run seed` with the same connection env the gateway injects (default
`PG*`, or remapped names from `preview.env`).

To force a re-seed against the existing database without tearing down, pass
`--reseed` with `-s` (or `sprout ci reseed -s …`):

```bash
sprout deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" --reseed
```

With `sprout ci preview` the same flag applies (`sprout ci preview
--reseed`) — it re-seeds even when the seed image is unchanged. When
`seed.inputs` change on an existing MR, the new tag builds, pushes,
deploys, and re-seeds automatically with no flag (a seed-tag change alone
never replaces the app container). Fresh MRs never need `--reseed`
(first seed always runs), and syncs without seed changes reuse the
image with no flag. The component does not pass `--reseed` itself; add it
to the `sprout ci preview` invocation (component override or hand-rolled
job) only for pipelines that must re-run an unchanged seed image, then
remove it.

## Multi-image previews (app + services)

Routing examples only — merge, lifecycle, and health-gate rules live in the
[Reference](#reference).

Full-stack previews often need more than one long-lived container sharing the
same preview database (API + worker, web + secondary service, etc.). With
`sprout ci preview` pass repeatable `--service name=image`. Low-level deploys
use the same flag:

```bash
sprout deploy -i "$APP_IMAGE" \
  --service api=ghcr.io/org/api:${SHA} \
  --service worker=ghcr.io/org/worker:${SHA}
```

Networks, shared connection env, teardown, and the app-only health gate
live in the [Reference](#reference) (Service images).

### Routing (optional)

Without routing metadata, a service is internal-only (reachable on the Docker
networks, no Traefik router). To expose a service, declare it under
`preview.services` in `.sprout.yaml`:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  services:
    - name: api
      # hostname suffix — distinct Host() rule
      hostname: "api-pr-{pr_id}.myapp.preview.example.com"
    - name: admin
      # path on the app hostname
      path: /admin
    - name: worker
      # no hostname/path → not Traefik-routed
```

```bash
sprout deploy -i "$APP_IMAGE" \
  --service api="$API_IMAGE" \
  --service admin="$ADMIN_IMAGE" \
  --service worker="$WORKER_IMAGE"
```

- `hostname` — `Host(\`…\`)` (supports `{pr_id}` like the app hostname).
- `path` — `PathPrefix(\`…\`)`; combined with `Host` via `&&`. Path-only uses
  the app hostname.

## Debugging

Low-level flow (appendix to the [Reference](#reference)): when a preview is
red, pull container logs through the gateway (no Docker
socket on the CI runner or laptop):

```bash
export SPROUT_URL=https://sprout.example.com
export SPROUT_TOKEN=<deploy-token>   # or admin token locally
sprout logs <pr_id> --tail 200
# optional when not in CI / not at a git remote:
# sprout logs <pr_id> --tail 200 --repo "https://github.com/org/repo"
```

Repo resolution matches `deploy` / `drop`: `--repo`, else `GITHUB_REPOSITORY` /
`CI_PROJECT_URL`, else `git remote get-url origin`. The deploy token is scoped
to one canonical repo — it cannot read another repo's previews.

Output is live app container logs, then seed logs when available. While the
seed container is still running, `sprout logs` reads it live; after a failed
seed the gateway has already captured stdout/stderr into `seed_log` (before
remove) so the seed section still shows why seeding died. Status polling keeps
a short `last_error_detail` (`exit=7`, `timeout`) — not the log blob.
Successful seeds do not keep seed output.

## CI workflow (GitHub Actions)

Low-level forge-specific flow (appendix to the [Reference](#reference)):
triggers mirror the GitLab component (open → deploy, synchronize →
re-deploy keeping the DB, close → teardown) — see the canonical workflow.

The **canonical** workflow is
[`examples/adopting-repo/.github/workflows/sprout.yml`](../examples/adopting-repo/.github/workflows/sprout.yml)
— copy it rather than pasting fragments from this guide. It covers:

1. Install the prebuilt `sprout` CLI from the matching release asset (see
   below), or from a workspace clone when hacking on sprout itself.
2. Build and push app + seed images tagged with `${{ github.sha }}`.
3. `sprout deploy -i … -s …`, capture `preview_url=` from `deploy.log`, comment
   on the PR.
4. On close, `sprout teardown` (idempotent — exit 0 if already gone).

### Install from a release asset

Pick the asset that matches the host libc (names are honest):

| Asset | Libc | Use when |
|---|---|---|
| `sprout-linux-x64` | glibc | Debian/Ubuntu runners (GitHub-hosted `ubuntu-*`) |
| `sprout-linux-x64-musl` | musl | Alpine runners; install `libstdc++` |

```bash
TAG=v0.6.0   # pin ≥ the release that ships glibc `sprout-linux-x64`

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

CLI environment in CI:

```yaml
env:
  SPROUT_URL: ${{ secrets.SPROUT_URL }}
  SPROUT_TOKEN: ${{ secrets.SPROUT_TOKEN }}
```

Canonical repo id is derived from `GITHUB_REPOSITORY` automatically.

Use `-i` only (no `-s`) when you do not need a seed image.

## Deploy token setup

One-time per adopting repo (operator or lead dev with admin token):

```bash
export SPROUT_URL=https://sprout.example.com
export SPROUT_TOKEN=<admin-token>
sprout admin token create \
  --scope deploy \
  --repo "https://github.com/${GITHUB_REPOSITORY}"
```

Add the returned token to the repo's `SPROUT_TOKEN` secret.

Reviewers may see brief 502 responses while the app migrates and starts —
Traefik routes exist before the app is healthy.

## Test coverage (maintainers)

Repo-relative paths for the Reference contract above (issue #130 linked
tests):

- Manifest parsing (all `.sprout.yaml` keys, including `preview.env` remap,
  `app_env` / `seed.env` grammar, services, health, `build`/`seed` blocks):
  `apps/cli/src/yaml.test.ts`
- Env value grammar (placeholders, `generate`, `required`):
  `apps/cli/src/app-env.test.ts`, `apps/cli/src/app-env-values.test.ts`
- CLI env layering (yaml + blob + files + flags):
  `apps/cli/src/commands/deploy-env.test.ts` (CLI side),
  `apps/server/src/http/deploy-env.test.ts` (gateway side)
- `sprout ci preview` (builds, seed content-hash + reuse gate, `--reseed`,
  service flags, seed env/args, tail, dotenv, health gate):
  `apps/cli/src/commands/ci-preview.test.ts`,
  `apps/cli/src/commands/seed-image.test.ts`
- `sprout ci` identity (both forges, detached/non-MR refusal):
  `apps/cli/src/commands/ci.test.ts`,
  `apps/cli/src/commands/ci-identity.test.ts`
- `teardown` / `reseed` / `logs`:
  `apps/cli/src/commands/ci-teardown-reseed-logs.test.ts`
- MR note wiring (best-effort, forge error body, no token leak):
  `apps/cli/src/commands/ci-note-wiring.test.ts`,
  `apps/cli/src/commands/forge-note.test.ts`
- Low-level `deploy` / services leave-clear-replace:
  `apps/cli/src/commands/deploy.test.ts`,
  `apps/cli/src/services.test.ts` (CLI shape),
  `apps/server/src/app-deployment/services.test.ts` (gateway shape)
- Gateway connection env (remap replaces names, colliding adopter keys
  stripped): `apps/server/src/app-deployment/pg-env.test.ts`
- Substituted hostname on a live deploy: `e2e/lifecycle.test.ts`
- Component inputs / dotenv / `on_stop` wiring: `templates/preview.test.ts`

## See also

- [Operator deployment](deploy.md)
- `CONTEXT.md`
