# Adopting repo guide

Wire your repository to a running sprout gateway. CI builds and pushes
container images; `sprout` calls the gateway API. CI never touches Postgres
admin credentials or the Docker socket.

Copy-paste files live in [`examples/adopting-repo/`](../examples/adopting-repo/).

## Prerequisites

- Operator has deployed the [operator compose stack](deploy.md) (or an
  equivalent gateway against external Postgres/Traefik). The gateway needs an
  admin Postgres DSN with `CREATEROLE` (or superuser); it creates the preview
  login itself — adopting repos never run SQL.
- A **deploy token** scoped to your repo's canonical id
  (`https://github.com/<org>/<repo>`).
- CI secrets: `SPROUT_URL`, `SPROUT_TOKEN`.
- Pull credentials on the gateway (`SPROUT_REGISTRY_AUTHS_JSON` per host, or legacy `SPROUT_REGISTRY_USER`/`PASSWORD`; empty = anonymous); image host comes from the deploy `app_image`.

## `.sprout.yaml`

Add at the repo root. The CLI reads this file locally and sends parsed values
to the gateway. Unknown keys are rejected.

Minimal (app only, default health checks):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

With seeding (`health` block **required** when using `-s`):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
```

- `slug` — short name used in database names (`sprout_<slug>_pr<id>`) and
  container names. Alphanumeric.
- `preview.hostname` — per-PR URL host template. Must contain `{pr_id}`
  (only `{pr_id}` is supported — no scheme, port, path, or other
  placeholders). The CLI owns the substitution, validates the resulting
  host, and prints `preview_url=` — CI must read the preview URL from that
  output and never reconstruct the hostname itself.
- `preview.env` — optional remap of the connection env **names** the
  gateway injects (see below). Unmapped keys stay canonical (`PG*` /
  `PGAPP*`).
- `preview.app_env` — optional adopter env for the app container. String
  values may interpolate `{hostname}`, `{pr_id}`, `{commit_sha}`; use
  `{ generate: stable_per_pr }` for a per-MR secret derived from the
  deploy token and `{ required: true }` for a key CI must supply (see Extra app
  env). CI secrets still come via `SPROUT_APP_ENV` / `--app-env-file` /
  `--app-env`.
- `health` — optional HTTP poll the gateway runs against the app container
  IP on the Postgres network. When omitted, the gateway polls `GET /health`
  every `2s` for up to `120s`, expecting `200`. Add a `health` block only to
  override those defaults. The block is still **required** when deploying
  with a seed image (`-s`); it gates the after-healthy seed hook (see
  below). Malformed durations fail fast at manifest parse time (form is
  `Ns`, e.g. `2s`).
- `preview.services` — optional list of companion services (name + optional
  `hostname` / `path` / static `image`). Images are usually supplied with
  repeatable `--service name=image` on deploy (see Multi-image previews).

## App image: migrate at startup

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

Remap the **names** (not values) with optional `preview.env` in `.sprout.yaml`.
Unmapped keys still inject under their canonical names. Remapping replaces
the name (no dual alias):

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

Adopters often need runtime env beyond the connection fields
(`BETTER_AUTH_SECRET`, app URLs, trusted origins, etc.).
Pass those as:

- Map in `.sprout.yaml` under `preview.app_env` (computed defaults; no CI
  secrets in git)
- One masked, **file-type** CI variable holding a dotenv blob —
  `SPROUT_APP_ENV` (app) and `SPROUT_SEED_ENV` (seed); the CLI reads the file
  path from the variable automatically
- Repeatable `--app-env-file PATH` / `--seed-env-file PATH` (explicit dotenv
  files; blank lines, `#` comments, optional `export ` prefix)
- Repeatable `--app-env KEY=VALUE` / `--seed-env KEY=VALUE` (one-offs from CI)

String values may use `{hostname}`, `{pr_id}`, and `{commit_sha}`
(`{hostname}` is the substituted preview host; `{commit_sha}` needs
`GITHUB_SHA` or `CI_COMMIT_SHA`). Request a secret that stays identical
across redeploy and reseed of the same MR with `{ generate: stable_per_pr }`
— an HMAC of `(canonical_repo_id, pr_id, env_key)` keyed by the sprout
deploy token (`SPROUT_TOKEN`). Keep that token stable for the MR’s lifetime
or sessions will invalidate when it rotates.

Declare a key that CI must supply (never the manifest) with
`{ required: true }`; if no file or flag provides it, deploy fails before the
gateway call naming the key instead of letting the container crash-loop:

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

Placeholders expand in **every** layer (manifest, file blob, and
`--app-env`), so a blob entry like `BETTER_AUTH_URL=https://{hostname}`
works. The file-type CI variable is read automatically:

```bash
sprout deploy -i "$APP_IMAGE"
```

CLI merge order: yaml `app_env` (after placeholder / generate expansion)
first, then `SPROUT_APP_ENV` / each `--app-env-file` in order, then
`--app-env` flags (later wins on duplicate keys; one entry per key on the
wire). `--seed-env-file` / `SPROUT_SEED_ENV` / `--seed-env` follow the same
order for the seed container. Required keys are checked after all layers.
Invalid dotenv lines or flags fail before any gateway call and name the
offending key or file **without echoing the value**. Gateway connection
keys replace colliding adopter keys (canonical PG* ∪ remapped names) —
same policy as seed env.

#### CI: one masked file-type variable

Store the app secrets as a single dotenv blob in `SPROUT_APP_ENV` (and, when
seeding, `SPROUT_SEED_ENV`). The blob supports `.env` syntax: blank lines,
`#` comments, an optional `export ` prefix, and `KEY=value` (values may
contain `=`; keys are trimmed and matching surrounding quotes are stripped).
Placeholders such as `{hostname}` expand per value.

**GitLab** — create a CI/CD variable named `SPROUT_APP_ENV`, type **File**,
marked **Masked**. GitLab writes the blob to a temp file and exports its path;
the CLI reads it automatically:

```yaml
script:
  - sprout deploy -i "$APP_IMAGE"
```

**Masked** keeps the value out of job logs; **File** means only the temp path
is exported to the job. The CLI never prints env values, and its parse errors
never echo a line.

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

The gateway's only post-startup timing hook is **after-healthy**: once the
preview app passes `health.expect`, an optional **seed image** runs. That is
how you sequence "migrate in the app, then seed" with zero API-code changes —
no `wait-for-postgres` / sleep loops in the seed path to wait for migrations.

Express it with `.sprout.yaml` health settings plus deploy flags:

```yaml
# .sprout.yaml — health block required when using -s
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
health:
  path: /health
  interval: 2s
  timeout: 120s
  expect: 200
```

```bash
sprout deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" \
  --seed-env FIXTURE_SET=demo \
  --seed-arg --reset
```

[`examples/adopting-repo/Dockerfile.seed`](../examples/adopting-repo/Dockerfile.seed)
shows a minimal seed image: install deps, copy seed script, entrypoint runs
`bun run seed` with the same connection env the gateway injects (default
`PG*`, or remapped names from `preview.env` — see
`docker-seed-entrypoint.sh`).

### Ordering contract

1. App container starts (entrypoint waits for Postgres, runs migrations, serves).
2. Gateway polls `health.path` on the Postgres-network container IP until
   `health.expect` (default 200) or `health.timeout`.
3. **After healthy:** if `-s` / `seed_image` was provided and this PR has never
   seeded successfully (`seeded_at` unset), the gateway runs the seed image once
   with the same connection-env remap as the app, plus `--seed-env` /
   `--seed-arg`. `--reseed` clears `seeded_at` after a healthy attach (replace)
   or on seed-phase entry (seed-only), so the same after-healthy gate re-runs.
4. Preview status becomes `running` with `seeded_at` set.

On later synchronize deploys, seeding is skipped when `seeded_at` is already
set (pass `-s` only when you intend to seed or resume). Clients may omit `-s`
on sync to avoid an unused seed-image pull. To force a re-seed against the
**existing** database without tearing down, pass `--reseed` with `-s`:

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

Full-stack previews often need more than one long-lived container sharing the
same preview database (API + worker, web + secondary service, etc.). Pass
repeatable `--service name=image` alongside `-i`:

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
  the image for that name. Every service needs an image after merge.

Pass `--service` when companions should be created or refreshed. Omitting
`--service` (and yaml services) leaves existing companions in place. Pass
`--clear-services` to remove all companions (`services: []` on the API).
`--clear-services` cannot be combined with `--service`. An empty
`preview.services: []` in `.sprout.yaml` is rejected — omit the key to leave,
or use `--clear-services` to clear. Seed-only reseed (`--reseed` with unchanged
app image/hostname) can refresh companions without replacing the app when
`--service` is passed.

## Debugging

When a preview is red, pull container logs through the gateway (no Docker
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

Symmetric triggers — no forge webhooks on the gateway:

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
| `sprout-linux-x64-musl` | musl | Alpine runners (DCOS / erntastic); install `libstdc++` |

```bash
TAG=v0.6.0   # pin ≥ the release that ships glibc `sprout-linux-x64` (not v0.5.0)

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

## See also

- [Operator deployment](deploy.md)
- `docs/adr/0003-seed-as-user-image.md`
- `docs/adr/0004-ci-driven-lifecycle-no-webhooks.md`
- `CONTEXT.md`
