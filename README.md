# sprout

**v0.1.0** — per-PR **preview databases** (and optional preview app containers)
for self-hosted deployments.

When a pull request opens, CI calls the sprout **gateway**, which
provisions an isolated **logical database** on a shared Postgres instance,
starts a preview app container, optionally runs a seed image, and tears
everything down when the PR closes. Lifecycle is **CI-driven** (`sprout
deploy` / `sprout teardown`) — the gateway does not take forge webhooks.

```
create DB → start app (migrate) → seed (optional) → running → drop
```

## Why

Preview deployments often share one database with production or with each
other. Migrations in previews then mutate shared state. sprout gives
every PR its own database on a single shared Postgres — low overhead, full
data isolation per PR.

## Two roles

| Who | Job |
|---|---|
| **Operator** | Deploy Postgres + gateway + Traefik once ([compose stack](docs/deploy.md)). Issue deploy tokens. |
| **Adopting repo** | Add `.sprout.yaml` + CI that builds images and runs `sprout deploy` / `sprout teardown` ([adoption guide](docs/adoption.md)). |

## Preview databases

Each PR gets one logical database on the **shared** Postgres instance — not a
new Postgres server.

| | |
|---|---|
| **Name** | `sprout_<slug>_pr<id>` (slug from `.sprout.yaml`, id = forge PR number) |
| **Created by** | Gateway **preview-db** module on first successful `POST /v1/deploy` for that `(repo, pr)` |
| **Credentials** | Static preview role (`sprout_preview` by default); gateway injects `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` into app and seed containers (names remappable via `preview.env` in `.sprout.yaml`) |
| **Dropped by** | `sprout teardown` (CI on PR close), operator `sprout drop <pr_id> --yes`, or **sweep** if teardown was missed |

Under the hood on first deploy: write a provisioning row in SQLite →
`CREATE DATABASE` under a db-name lock → grant the preview role → continue
into app deployment. Re-deploys (PR synchronize) **keep** the same database
and replace the app container only.

### Verify a preview database

```bash
export SPROUT_URL=http://127.0.0.1:7331
export SPROUT_TOKEN=<deploy-or-admin-token>

sprout list                          # JSON previews; check db_name + status
sprout doctor                        # gateway + Postgres + Docker sanity

# On the Postgres host / network (operator):
docker compose --env-file compose.env exec postgres \
  psql -U postgres -c '\l' | grep sprout_
```

## Preview deployments

CI (or a developer with a deploy token) drives the full preview lifecycle.
The CLI talks to the gateway over HTTP; it never needs Postgres admin
credentials or the Docker socket.

### Commands

From a clone (`bun install`), the CLI entrypoint is `apps/cli/src/index.ts`
(bin name `sprout`). In this repo you can also use `bun run pbuddy …`.

```bash
export SPROUT_URL=http://127.0.0.1:7331   # default if unset
export SPROUT_TOKEN=<deploy-token>

# PR open / synchronize — requires .sprout.yaml in cwd
sprout deploy -i ghcr.io/org/app:sha
sprout deploy -i ghcr.io/org/app:sha -s ghcr.io/org/app-seed:sha \
  --seed-env FIXTURE_SET=demo

# Prints: preview_url=https://pr-<id>.…
# Exit non-zero unless status is running and preview_url is set.

# PR close — identity from GITHUB_REPOSITORY + event payload (or git remote)
sprout teardown

# Operator introspection / purge
sprout list
sprout doctor
sprout drop <pr_id> --yes            # confirm required; exit 2 without --yes
sprout admin token create --scope deploy --repo https://github.com/org/repo
sprout health                        # GET /healthz (no token)
```

Canonical CI workflow (build images → deploy → comment URL → teardown on
close): [`examples/adopting-repo/.github/workflows/sprout.yml`](examples/adopting-repo/.github/workflows/sprout.yml).

### What `deploy` does under the hood

1. CLI reads `.sprout.yaml`, resolves canonical repo id + PR id, `POST /v1/deploy`.
2. Gateway pulls the app image (and seed image if `-s`).
3. **Create** the preview database if this PR has none yet.
4. **Replace** the preview app container (Traefik labels on the traefik
   network; Postgres reachability on the postgres network). Injects connection
   env (optionally remapped by `preview.env`).
5. App entrypoint waits for Postgres, runs **migrations**, starts the server.
6. Gateway **health-polls** the container (defaults, or `health` in yaml —
   required when seeding).
7. Optional **seed image** runs once (skipped on later syncs once `seeded_at`
   is set). Gateway connection keys win over colliding `--seed-env` values.
8. Status → `running`; CLI prints `preview_url=…`.

`teardown` removes the container, drops the database, and tombstones the
control-plane row (idempotent if already gone). **Sweep** periodically
reconciles forge open-PR lists against gateway state if CI missed a teardown.

### Verify a preview deployment

```bash
sprout list                          # status should be "running"
curl -sf "https://pr-<id>.your.preview.host/health"   # or http://127.0.0.1:$TRAEFIK_HTTP_PORT with Host header

docker compose --env-file compose.env ps
docker ps --filter name=sprout-      # container name: sprout-<slug>-pr-<id>
```

## Operator quick start

```bash
cp compose.env.example compose.env
# Edit POSTGRES_PASSWORD, SPROUT_PREVIEW_POSTGRES_URL (keep in sync), SPROUT_PG_PASSWORD.

docker compose --env-file compose.env up -d --build
curl -sf http://127.0.0.1:7331/healthz
```

Full stack, gateway image build, Coolify/external Traefik overlay, and smoke
checklist: [`docs/deploy.md`](docs/deploy.md).

## Docs

- [`CONTEXT.md`](CONTEXT.md) — domain vocabulary
- [Spec #12](https://github.com/simpros/sprout/issues/12) — normative v0.1 specification
- [`docs/deploy.md`](docs/deploy.md) — operator compose stack + gateway image build
- [`docs/adoption.md`](docs/adoption.md) — adopting-repo guide (yaml, CI, entrypoint)
- [`examples/adopting-repo/`](examples/adopting-repo/) — copy-paste example files
- [`e2e/`](e2e/) — acceptance harness against compose (`bun run test:e2e`)
- [`docs/adr/`](docs/adr/) — architecture decisions

## Status

**v0.1.0** (git tag `v0.1.0`). Core gateway paths land incrementally; see open
issues on the tracker for remaining modules.
