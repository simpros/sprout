# Adopting repo guide

Wire your repository to a running sprout gateway. CI builds and pushes
container images; `sprout` calls the gateway API. CI never touches Postgres
admin credentials or the Docker socket.

Copy-paste files live in [`examples/adopting-repo/`](../examples/adopting-repo/).

## Prerequisites

- Operator has deployed the [operator compose stack](deploy.md).
- A **deploy token** scoped to your repo's canonical id
  (`https://github.com/<org>/<repo>`).
- CI secrets: `SPROUT_URL`, `SPROUT_TOKEN`.
- Container registry your gateway can pull from (configured once on the gateway).

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

With remapped connection env names (optional). Canonical keys are the five
libpq-style names the gateway knows; values are the names your app image
reads. Unlisted canonical keys still inject as `PG*`. The same map applies to
preview **app** and **seed** containers. Remapping **replaces** the name (the
gateway does not also emit `PGHOST` when you map it to `DATABASE_HOST`).

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  env:
    PGHOST: DATABASE_HOST
    PGPORT: DATABASE_PORT
    PGUSER: DATABASE_USER
    PGPASSWORD: DATABASE_PASSWORD
    PGDATABASE: DATABASE_NAME
```

- `slug` — short name used in database names (`sprout_<slug>_pr<id>`) and
  container names (`sprout-<slug>-pr-<id>`). Alphanumeric.
- `preview.hostname` — per-PR URL host; `{pr_id}` is substituted at deploy time.
- `preview.env` — optional map from canonical `PGHOST` / `PGPORT` / `PGUSER` /
  `PGPASSWORD` / `PGDATABASE` to adopter env names. Keys other than those five,
  empty values, invalid identifiers, or two keys mapping to the same target are
  rejected. The map is sent on each `deploy` (not stored in gateway state).
- `health` — HTTP poll the gateway runs against the app container IP on the
  Postgres network before starting a seed container.

## App image: migrate at startup

By default the gateway injects **only** these environment variables into
preview app containers:

```
PGHOST  PGPORT  PGUSER  PGPASSWORD  PGDATABASE
```

With `preview.env`, each listed key is emitted under the mapped name instead.
Your app image must:

1. Wait until Postgres accepts connections.
2. Run migrations against the injected database name.
3. Start the web server (expose a port — first `EXPOSE` wins, else gateway uses
   `SPROUT_PREVIEW_PORT_DEFAULT`).

There is **no mandatory wrapper image** from sprout. Copy an entrypoint
that fits your stack.

**Non-goal / follow-up:** sprout injects a single preview login. A second
restricted role (e.g. privileged migrator + `app_user` under RLS) is not
provisioned or injected — adopters that need dual-role credentials must wait
for a later feature or handle it outside sprout.

### Shell entrypoint (any runtime)

See [`examples/adopting-repo/docker-entrypoint.sh`](../examples/adopting-repo/docker-entrypoint.sh):

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

## Optional seed image

Build a separate one-shot image when seed data is not part of the app image.
The gateway runs it after the app passes the health check, **once per PR**
(subsequent synchronize deploys skip seeding when `seeded_at` is set).

[`examples/adopting-repo/Dockerfile.seed`](../examples/adopting-repo/Dockerfile.seed)
shows a minimal pattern: install deps, copy seed script, entrypoint runs
`bun run seed` using the same connection env the gateway injects (see
`docker-seed-entrypoint.sh`) — default `PG*`, or remapped names from
`preview.env`.

Pass runtime inputs without storing secrets in yaml:

```bash
sprout deploy -i "$APP_IMAGE" -s "$SEED_IMAGE" \
  --seed-env FIXTURE_SET=demo \
  --seed-arg --reset
```

User `--seed-env` entries are applied first; gateway connection env (default
`PG*` or remapped names) is appended last and wins on name collision.

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

1. Install `sprout` from a workspace clone (keeps `@sprout/api-client`
   resolution; pin a tag/SHA when releases exist).
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
- `docs/adr/0006-sprout-identity-and-preview-env.md`
- `CONTEXT.md`
