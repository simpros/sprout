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
- `preview.hostname` — per-PR URL host; `{pr_id}` is substituted at deploy time.
- `preview.env` — optional remap of the connection env **names** the
  gateway injects (see below). Unmapped keys stay canonical (`PG*` /
  `PGAPP*`).
- `preview.app_env` — optional static string map injected into the app
  container (see Extra app env). Prefer `--app-env` / `--app-env-file` for
  secrets.
- `health` — HTTP poll the gateway runs against the app container IP on the
  Postgres network. Required when using `-s`; gates the after-healthy seed hook
  (see below).

## App image: migrate at startup

By default the gateway injects these connection variables into preview app
and seed containers:

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

- Static map in `.sprout.yaml` under `preview.app_env` (no secrets in git)
- Repeatable `--app-env-file PATH` (dotenv `KEY=VALUE` file; blank/`#` lines skipped)
- Repeatable `--app-env KEY=VALUE` (secrets or one-offs from CI)

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  app_env:
    LOG_LEVEL: info
    FEATURE_PREVIEW_BANNER: "1"
```

```bash
sprout deploy -i "$APP_IMAGE" \
  --app-env-file "$PREVIEW_APP_ENV" \
  --app-env BETTER_AUTH_URL="https://pr-${PR_ID}.myapp.preview.example.com"
```

CLI merge order: yaml `app_env` first, then each `--app-env-file` in flag
order, then `--app-env` flags (later wins on duplicate keys; one entry per
key on the wire). Invalid dotenv lines or flags fail before any gateway
call. Gateway connection keys replace colliding adopter keys (canonical
PG* ∪ remapped names) — same policy as seed `--seed-env`. Seed env applies
only to the seed container.

#### CI: dotenv file from variables

**GitLab** — store a file-type CI/CD variable (e.g. `PREVIEW_APP_ENV`). GitLab
writes the file and exposes its path in `$PREVIEW_APP_ENV`:

```yaml
script:
  - sprout deploy -i "$APP_IMAGE" --app-env-file "$PREVIEW_APP_ENV"
```

**GitHub Actions** — no file-type secrets; write a multiline secret/var to a
temp file, then pass the path:

```yaml
- name: Write preview app env
  env:
    PREVIEW_APP_ENV: ${{ secrets.PREVIEW_APP_ENV }}
  run: |
    printf '%s\n' "$PREVIEW_APP_ENV" > "$RUNNER_TEMP/preview.app.env"
    echo "PREVIEW_APP_ENV_FILE=$RUNNER_TEMP/preview.app.env" >> "$GITHUB_ENV"
- name: Deploy
  run: sprout deploy -i "$APP_IMAGE" --app-env-file "$PREVIEW_APP_ENV_FILE"
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
   seeded successfully (`seeded_at` unset), **or** `--reseed` was passed, the
   gateway runs the seed image once with the same connection-env remap as the
   app, plus `--seed-env` / `--seed-arg`.
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

1. Install `sprout` from a workspace clone pinned to a SHA/branch of this
   tree (or the `v0.2.0` release when published; keeps `@sprout/api-client`
   resolution; same as the in-repo `sprout` bin).
2. Build and push app + seed images tagged with `${{ github.sha }}`.
3. `sprout deploy -i … -s …`, capture `preview_url=` from `deploy.log`, comment
   on the PR.
4. On close, `sprout teardown` (idempotent — exit 0 if already gone).

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
