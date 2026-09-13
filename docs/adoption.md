# Adopting repo guide

The one-include flow: one component include, one `.sprout.yaml`, two CI
variables — a working seeded preview with no adopter shell scripts. CI never
touches Postgres admin credentials.

- New adopter? Read [Quickstart](#quickstart-gitlab-component) only.
- Need an exact key or flag? See [Reference](#reference).
- On a hand-rolled `curl` / `docker build` / `sprout deploy` script? See
  [Migration](#migration-from-a-hand-rolled-script).
- Red pipeline? See [Troubleshooting](#troubleshooting).

Copy-paste app files (Dockerfiles, entrypoints, seed script) live in
[`examples/adopting-repo/`](../examples/adopting-repo/).

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

**2. Required CI variables** (project or group settings; full variable
reference, including file-type blobs and the `GITLAB_TOKEN` fallback, in
[`templates/README.md`](../templates/README.md)):

| Variable | Type | Purpose |
|---|---|---|
| `SPROUT_URL` | Variable, masked | Gateway URL (or pass the `sprout_url` input instead) |
| `SPROUT_TOKEN` | Variable, masked | Deploy token scoped to the repo's canonical id (see [Deploy token setup](#deploy-token-setup)) |
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
  pushes the app image (`CI_REGISTRY_IMAGE:<SHA>`) and the seed image (same
  repository, `<SHA>-seed` tag suffix), deploys, writes `PREVIEW_URL=` to the
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

## Reference

### Manifest keys (`.sprout.yaml`)

The CLI reads this file locally and sends parsed values to the gateway.
Unknown keys are rejected (`unknown key: <path>`). This table is the
contract; the sections below it are examples and flow notes only. Test
pointers live in [Test coverage](#test-coverage-maintainers).

| Key | Required | Default | Purpose |
|---|---|---|---|
| `slug` | yes | — | Short name used in database names (`sprout_<slug>_pr<id>`) and container names. Alphanumeric. |
| `preview.hostname` | yes | — | Per-PR host template. Must contain `{pr_id}`; no scheme, port, path, or other placeholders. The CLI owns substitution, validates the host, and prints `preview_url=` — CI reads the URL from that output and never reconstructs it. |
| `preview.env` | no | canonical `PG*` / `PGAPP*` | Remap of the connection env **names** the gateway injects (see [App image](#app-image-migrate-at-startup)). Unmapped keys stay canonical; remapping replaces the name (no dual alias). |
| `preview.app_env` | no | — | Adopter env for the app container. Value grammar: plain string, `{ generate: stable_per_pr }`, or `{ required: true }`. Strings may interpolate `{hostname}`, `{pr_id}`, `{commit_sha}` (`{commit_sha}` follows the forge SHA, `CI_COMMIT_SHA` on GitLab / `GITHUB_SHA` on GitHub). `generate` derives a per-MR secret (HMAC of repo, MR, key, keyed by the deploy token — keep the token stable for the MR lifetime). `required` must be supplied by CI (`SPROUT_APP_ENV` / `--app-env-file` / `--app-env`); missing keys fail before the gateway call naming the key. Merge order: yaml first, then `SPROUT_APP_ENV` / each `--app-env-file` in order, then `--app-env` flags (later wins per key). |
| `preview.services` | no | leave companions | Companion services: list of `{ name, image?, hostname?, path? }`. `hostname` gives a distinct `Host()` rule (supports `{pr_id}`); `path` gives a `PathPrefix()` on the app hostname; combined with `&&`. Static `image` pins the image; `--service name=image` overlays it — every service needs an image after merge. Omitting `--service` leaves companions in place; `--clear-services` removes all. An empty list is rejected (omit the key, or `--clear-services`). |
| `preview.services[].name` | per entry | — | Service name (validated, unique). |
| `preview.services[].image` | per entry unless `--service` | — | Pinned image for the service. |
| `preview.services[].hostname` | no | internal-only | Distinct `Host()` for the service. |
| `preview.services[].path` | no | internal-only | `PathPrefix()` for the service (must start with `/`). |
| `health.path` | when seeding | `/health` | HTTP path the gateway polls on the Postgres-network container IP. |
| `health.interval` | when seeding | `2s` | Poll interval (`Ns` form, e.g. `2s`; malformed durations fail at manifest parse). |
| `health.timeout` | when seeding | `120s` | How long the gateway polls before `health_timeout`. Never starts the seed. |
| `health.expect` | when seeding | `200` | Expected status (100–599). Gates the after-healthy seed hook. |
| `build.dockerfile` | no | `Dockerfile` | App Dockerfile for `sprout ci preview`. An empty `build: {}` takes the default. |
| `seed.dockerfile` | when `seed:` present | `Dockerfile.seed` | Seed Dockerfile. An empty `seed: {}` takes the default and enables seeding. |
| `seed.env` | no | — | Seed-only env, same value grammar and templating as `preview.app_env`. `required` keys come from `SPROUT_SEED_ENV` / `--seed-env-file` / `--seed-env`. Merge order: yaml first, then blob / files in order, then flags. |
| `seed.args` | no | — | Seed container args. Yaml entries first, then `--seed-arg` flags appended. |

Minimal app-only manifest (defaults apply):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

Seeded manifest (as in the quickstart): add `health:` + `seed:` as shown
above. `seed: {}` alone enables seeding with the conventional
`Dockerfile.seed`.

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
`spec:include`, no global keywords).

| Input | Default | Purpose |
|---|---|---|
| `sprout_version` | release tag shipping the file (sentinel replaced at publish) | CLI release to install (checksum-verified). Override to pin or trial another build. Remote includes must set it explicitly to the tag in the URL. |
| `stage` | `deploy` | Stage for both jobs. |
| `sprout_url` | `""` (use `$SPROUT_URL`) | Gateway URL override. |
| `app_context` | `.` | Directory holding `.sprout.yaml`; the CLI builds (`docker build … .`) and resolves Dockerfiles relative to it. |
| `auto_stop_in` | `1 week` | `environment:auto_stop_in` for the preview. |
| `app_env_file` | `""` | Project-root-relative extra dotenv file passed as `--app-env-file` (on top of `SPROUT_APP_ENV`). Resolved before `cd` into `app_context`. |
| `seed_env_file` | `""` | Project-root-relative extra seed dotenv file passed as `--seed-env-file`. Same rule. |
| `dotenv_file` | `sprout-preview.env` | Project-root-relative dotenv artifact carrying `PREVIEW_URL` to `environment:url`. Parent directories must already exist. |
| `tail` | `200` | Gateway log lines printed when `sprout ci preview` fails. |

## Migration from a hand-rolled script

If your `.gitlab-ci.yml` currently installs the CLI, builds/pushes images,
and calls `sprout deploy` by hand, replace the whole job with the component.
Concretely, delete:

1. The `curl` install block (version pin, asset selection, `chmod`,
   `libstdc++` handling) — the component installs the pinned,
   checksum-verified binary matching the component version.
2. The `docker build` / `docker push` steps and registry-login script — the
   component owns the dind service and login; `sprout ci preview` builds and
   pushes the app image and, when `.sprout.yaml` configures `seed`, the seed
   image.
3. The `sprout deploy -i … -s …` invocation, `preview_url=` scraping, dotenv
   writing, and `sprout teardown` script — the component calls
   `sprout ci preview` / `sprout ci teardown`, writes the dotenv artifact,
   and posts the MR note.
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
| Invalid dotenv line or flag | names the offending key or file, value never echoed | Fix the `KEY=value` line (blank lines, `#` comments, optional `export ` prefix; values may contain `=`); check `--tail` is a positive integer (`--tail must be a positive integer`). |
| Deploy never becomes healthy | `health_timeout` (gateway log tail printed first), `deploy_timeout` on poll expiry | Pull `sprout logs <mr_id> --tail 200`: app crash-loop (migrations, missing env, wrong port) is the usual cause. Reviewers may see brief 502s while the app migrates — Traefik routes exist before the app is healthy. |
| Seed fails | `seed_failed` (exit code or `timeout` in `last_error_detail`); app **stays up** and routable, `seeded_at` unset | Fix the seed image and redeploy with `-s` (resume path — no Traefik replace when image + hostname are unchanged). Seed wall-clock is `SPROUT_SEED_TIMEOUT` (default `180s`); health timeout is separate and never starts the seed. |
| `sprout ci reseed` without an image | `ci reseed requires -s <seed-image>` | Pass `-s` with the seed image; reseed runs against the existing database without rebuilding. |

## App image: migrate at startup

Reference above is the contract; this section is entrypoint examples only.

By default the gateway injects these connection variables into preview app,
service, and seed containers:

```
PGHOST  PGPORT  PGUSER  PGPASSWORD  PGDATABASE
PGAPPUSER  PGAPPPASSWORD
```

- **Owner** (`PGUSER` / `PGPASSWORD`): the static preview login
  (`SPROUT_PG_USER`). Owns each preview database — use this for migrations.
- **Restricted companion** (`PGAPPUSER` / `PGAPPPASSWORD`): a per-preview
  LOGIN named `<dbName>_app` (e.g. `sprout_myapp_pr42_app`) with `CONNECT`
  and schema `USAGE` only. Password is derived by the gateway (stable for
  the life of the preview). Use this for RLS-constrained runtime queries.

Remap the connection env **names** with `preview.env` (contract in the
[Reference](#reference); example only here):

```yaml
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  env:
    PGHOST: DATABASE_HOST
    PGDATABASE: DATABASE_NAME
    PGAPPUSER: APP_DATABASE_USER
    PGAPPPASSWORD: APP_DATABASE_PASSWORD
```

If you remap, your entrypoint must read the adopter names; the snippets below
assume the default `PG*` / `PGAPP*` map.

Your app image must:

1. Wait until Postgres accepts connections.
2. Run migrations as the **owner** against the injected database name
   (default `PGDATABASE`). Migrations that create an `app_user` role should
   instead `GRANT` table privileges to the companion role named in
   `PGAPPUSER` (do not `CREATE ROLE` — the gateway already provisioned it).
3. Start the web server (expose a port — first `EXPOSE` wins, else gateway uses
   `SPROUT_PREVIEW_PORT_DEFAULT`), connecting runtime queries as
   `PGAPPUSER` when you need RLS.

There is **no mandatory wrapper image** from sprout. Copy an entrypoint
that fits your stack.

### Dual-role (RLS) previews

Product databases that use a privileged owner + restricted RLS role work on
previews without cluster `CREATEROLE` on the preview login:

1. Migrate with `PGUSER` / `PGPASSWORD` (owner).
2. `GRANT` the needed table/sequence privileges to the role in `PGAPPUSER`
   (and enable RLS / policies as in production).
3. Open the app pool with `PGAPPUSER` / `PGAPPPASSWORD` (remap to
   `APP_DATABASE_USER` / `APP_DATABASE_PASSWORD` via `preview.env` if that
   matches your product env names).

Teardown drops the database and then the companion role.

### Extra app env (non-connection)

Value grammar, templating, and merge order live in the
[Reference](#reference) (`preview.app_env` / `seed.env`) — this section is
wiring and one example only.

Adopters often need runtime env beyond the connection fields
(`BETTER_AUTH_SECRET`, app URLs, trusted origins, etc.).
Pass those as `preview.app_env` / `seed.env` in `.sprout.yaml`, a masked
file-type `SPROUT_APP_ENV` / `SPROUT_SEED_ENV` dotenv blob (the CLI reads the
file path from the variable automatically), repeatable `--app-env-file` /
`--seed-env-file`, or repeatable `--app-env KEY=VALUE` / `--seed-env
KEY=VALUE`.

Gateway connection keys replace colliding adopter keys (canonical `PG*` ∪
remapped names after `preview.env`) — same policy for app and seed env (see
`apps/server/src/app-deployment/pg-env.ts`). Do not put `PGHOST` or a
remapped name into `SPROUT_APP_ENV`: the gateway strips it in favour of its
own value and the app will silently get the gateway's connection, not yours.

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

Placeholders (`{hostname}`, `{pr_id}`, `{commit_sha}`) expand in every layer —
see the [Reference](#reference).

**GitLab** — create a CI/CD variable named `SPROUT_APP_ENV`, type **File**,
marked **Masked**. GitLab writes the blob to a temp file and exports its path;
the CLI reads it automatically (the component passes nothing extra unless
you set the `app_env_file` / `seed_env_file` inputs for additional files).

**GitHub Actions** — no file-type secrets; write the multiline secret to a
temp file and point `SPROUT_APP_ENV` at it:

```yaml
- name: Write preview app env
  env:
    SPROUT_APP_ENV_BLOB: ${{ secrets.SPROUT_APP_ENV }}
  run: |
    printf '%s\n' "$SPROUT_APP_ENV_BLOB" > "$RUNNER_TEMP/preview.app.env"
    echo "SPROUT_APP_ENV=$RUNNER_TEMP/preview.app.env" >> "$GITHUB_ENV"
- name: Deploy
  run: sprout deploy -i "$APP_IMAGE"
```

Explicit wiring still works: pass `--app-env-file "$PATH"` (or
`--seed-env-file`) instead of setting the variable.

Secrets stay out of logs by construction: deploy prints only `preview_url=`
to stdout, parse errors never echo a line, and the MR note carries just the
URL. Prove it by grepping the captured job log for a sentinel from the blob:

```bash
sprout deploy -i "$APP_IMAGE" | tee deploy.log
! grep -q "sk_live" deploy.log
```

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

Reference above is the contract for `health.*` / `seed.*` keys and CLI
flags; this section is the run-order flow and low-level examples only.

The gateway's only post-startup timing hook is **after-healthy**: once the
preview app passes `health.expect`, an optional **seed image** runs. That is
how you sequence "migrate in the app, then seed" with zero API-code changes —
no `wait-for-postgres` / sleep loops in the seed path to wait for migrations.

With the component you declare it once in `.sprout.yaml` (quickstart) and
never pass `-s` in CI — `sprout ci preview` builds + pushes the seed image
(tag = app tag + a `-seed` suffix, same repository) and deploys with it.
The low-level equivalent is `sprout deploy -i … -s …` with
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

### Ordering contract

1. App container starts (entrypoint waits for Postgres, runs migrations, serves).
2. Gateway polls `health.path` on the Postgres-network container IP until
   `health.expect` (default 200) or `health.timeout`.
3. **After healthy:** if a seed image was provided and this PR has never
   seeded successfully (`seeded_at` unset), the gateway runs the seed image once
   with the same connection-env remap as the app, plus `seed.env` /
   `--seed-env` and `seed.args` / `--seed-arg`. `--reseed` clears `seeded_at` after a healthy attach (replace)
   or on seed-phase entry (seed-only), so the same after-healthy gate re-runs.
4. Preview status becomes `running` with `seeded_at` set.

On later synchronize deploys, seeding is skipped when `seeded_at` is already
set. To force a re-seed against the **existing** database without tearing down,
pass `--reseed` with `-s` (or `sprout ci reseed -s …`):

```bash
sprout deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" --reseed
```

Same image + hostname: seed-only (no app container replace). Image or hostname
change still replaces the app, then runs seed after healthy.

### Timeout

Seed wall-clock bound is the gateway env `SPROUT_SEED_TIMEOUT` (seconds,
default `180`), applied internally as `seedTimeoutMs` (seconds × 1000). A
timed-out seed is treated as failure (below). Health timeout is separate
(`health.timeout` in yaml) and never starts the seed.

### Failure and visibility

| Outcome | Deploy response | Preview row | App container |
|---|---|---|---|
| Seed exit non-zero | `500` `{ "error": "seed_failed" }` | `status=failed`, `seeded_at` null | **Stays up** (routable) |
| Seed timeout | same | same | **Stays up** |
| Seed Docker/ops error | same | same | **Stays up** |
| Health timeout | `500` `{ "error": "health_timeout" }` | `status=failed` | Removed; seed never started |

Gateway logs `seed:failed` with the exit code or `"timeout"`. Reviewers may
still hit the app while the row is `failed` after a seed problem — fix the
seed image and redeploy.

### Resume

- **Failed or crash-mid-seed** (`status` `failed`/`seeding`, live app, same
  image + hostname): redeploy with `-s` resumes the seed only (no Traefik
  replace). Without `seed_image`, resume returns `422`
  `seed_image_required_to_resume_seeding`.
- **Image or hostname change:** full attach + health, then after-healthy seed
  again if `seeded_at` is still unset (or `--reseed` was passed).
- **Successful seed:** `seeded_at` set — synchronize does not re-seed unless
  you pass `--reseed` with `-s`. A failed reseed clears `seeded_at` and keeps
  the app up; resume with `-s` (no `--reseed` required) matches first-seed
  failure semantics. Tear down (or purge) only if you need a fresh database,
  not merely fresh fixtures.

## Multi-image previews (app + services)

Service merge and leave/clear rules live in the [Reference](#reference)
(`preview.services`, `--service`, `--clear-services`) — this section is
routing examples only.

Full-stack previews often need more than one long-lived container sharing the
same preview database (API + worker, web + secondary service, etc.). With
`sprout ci preview` pass repeatable `--service name=image`. Companions that
need new CLI/component surface require an explicit typed input (when/if
added) or a hand-written `sprout ci preview` job — there are no
service-related component inputs today. Low-level deploys use the same flag:

```bash
sprout deploy -i "$APP_IMAGE" \
  --service api=ghcr.io/org/api:${SHA} \
  --service worker=ghcr.io/org/worker:${SHA}
```

Each service:

1. Joins the **Traefik** and **Postgres** networks (same as the app).
2. Receives the **same connection env** as the app (`PGDATABASE` and companions,
   including any `preview.env` remap).
3. Is force-removed on **teardown** (and on replace) with the app.

The health gate still covers **only the app**. After the app passes
`health.expect`, seed runs (when configured), then companion services start.
There is no per-service health poll in this release.

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
- Static `image` in yaml is allowed for pinned images; `--service` overlays
  the image for that name. Every service needs an image after merge (see the
  [Reference](#reference) for the full leave / clear / reseed rules).

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
symmetric triggers — no forge webhooks on the gateway:

| Event | Action |
|---|---|
| `pull_request` opened | `sprout deploy` |
| `pull_request` synchronize | `sprout deploy` (replaces container, keeps DB) |
| `pull_request` closed | `sprout teardown` |

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

GitLab repos should prefer the [component quickstart](#quickstart-gitlab-component)
over this hand-written shape: `sprout ci preview` replaces the build / push /
deploy script path end to end (builds + pushes both images from
`build.dockerfile` / `seed.dockerfile`, deploys with the resolved env and
`-s`, reuses the async-deploy poll), and on success prints `preview_url=`
**and** writes `PREVIEW_URL=<url>` to the dotenv artifact (override with
`--dotenv-file PATH`) once the preview is actually healthy. On failure it
prints the gateway log tail (`--tail N`, default 200) before exiting with
the deploy error.

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
- `sprout ci preview` (builds, service flags, seed env/args, tail, dotenv,
  health gate): `apps/cli/src/commands/ci-preview.test.ts`
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
- `docs/adr/0003-seed-as-user-image.md`
- `docs/adr/0004-ci-driven-lifecycle-no-webhooks.md`
- `CONTEXT.md`
