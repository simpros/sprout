# Operator deployment

Deploy **Postgres**, the **sprout gateway**, and **Traefik** once per
environment. Adopting repos then call `sprout deploy` / `sprout teardown` from
CI — no per-repo server setup.

## Quick start (local smoke)

From the repo root:

```bash
cp compose.env.example compose.env
# Edit POSTGRES_PASSWORD, SPROUT_PREVIEW_POSTGRES_URL (keep in sync), SPROUT_PG_PASSWORD.
# URL-encode special characters in the DSN password.

docker compose --env-file compose.env up -d --build
docker compose --env-file compose.env ps
curl -sf http://127.0.0.1:7331/healthz
# Traefik HTTP entrypoint (host port TRAEFIK_HTTP_PORT, default 8880)
curl -sf http://127.0.0.1:${TRAEFIK_HTTP_PORT:-8880}/ || true
```

`compose.env` is the compose project env. Do **not** copy it to `.env` —
`.env` / `.env.example` are for the gateway process on the host (`bun run
dev`).

## Gateway Docker image

The gateway is **one image, one process** (root `Dockerfile`). Compose builds
it via `build: .`; you can also build and tag it alone for registry push or
external orchestrators:

```bash
# From the repo root (reproducible with Bun 1.4.0 base + frozen lockfile)
docker build -t ghcr.io/simpros/sprout:0.1.0 \
  --build-arg SPROUT_VERSION=0.1.0 \
  .
# Optional: push after docker login to GHCR (or your registry)
# docker push ghcr.io/simpros/sprout:0.1.0
```

Image label `org.opencontainers.image.version` mirrors `SPROUT_VERSION` (default
`0.1.0`). Pin operators and CI to an image built from this branch (or the
post-rename merge SHA). Do not treat today's git tag `v0.1.0` as that
artifact — it still points at the pre-rename tree until retagged.

Tear down:

```bash
docker compose --env-file compose.env down
# docker compose --env-file compose.env down -v   # also drops SQLite + Postgres volumes
```

The stack in `docker-compose.yml` is the reference **operator compose stack**
for local development and CI smoke. The **E2E acceptance harness** (`e2e/`)
runs the same file with `--env-file e2e/compose.e2e.env` — see
[`e2e/README.md`](../e2e/README.md) or `bun run test:e2e`. Default network
names (`sprout-traefik`, `sprout-postgres`) are project-local so
a smoke `up` does not collide with an existing Coolify Traefik network named
`traefik`. Host ports are `SPROUT_GATEWAY_HOST_PORT` (default 7331) and
`TRAEFIK_HTTP_PORT` (default 8880); the harness ports come from
`e2e/compose.e2e.env`.

## Defaults

Durable runtime identity uses product `sprout*` names:

| What | Default |
|---|---|
| Compose project / volumes | `sprout` / `sprout_*` |
| Control-plane SQLite | `/data/sprout.db` (compose) / `sprout.db` (host) |
| Traefik network | `sprout-traefik` |
| Postgres network | `sprout-postgres` |
| Preview Postgres roles | `sprout_admin` / `sprout_preview` |
| Preview container names | `sprout-<slug>-pr-<id>` |
| Preview database names | `sprout_<slug>_pr<id>` |

Upgrading from legacy `preview-buddy*` / `pb*` / `prev_*` defaults is a
**wipe-and-redeploy**: tear down volumes, networks, and control-plane state,
then bring the stack up again. There is no in-place migrator. Pin
`SPROUT_TRAEFIK_NETWORK` / `SPROUT_POSTGRES_NETWORK` / `SPROUT_STATE_DB_PATH`
(and role env vars) only when you intentionally use non-default names
(external Traefik, Coolify, etc.).

## Architecture

```text
                    ┌─────────────┐
   PR traffic ─────►│   Traefik   │  network: $SPROUT_TRAEFIK_NETWORK
                    │  (labels)   │
                    └──────┬──────┘
                           │ preview app containers
                    ┌──────▼──────┐
                    │   gateway   │  networks: traefik + postgres
                    │  (sprout)   │  + Docker socket
                    └──────┬──────┘
                           │ CREATE/DROP DATABASE (admin)
                    ┌──────▼──────┐
                    │  Postgres   │  network: $SPROUT_POSTGRES_NETWORK
                    │  (shared)   │
                    └─────────────┘
```

- **Postgres** hosts all preview logical databases (`sprout_<slug>_pr<id>`).
- **Gateway** administers databases, starts preview containers, and sets
  Traefik routing labels. It mounts the Docker socket and joins both networks.
- **Traefik** terminates HTTP for preview hostnames. Preview app containers
  attach only to `traefik` + `postgres`; seed containers attach to `postgres`
  only.

## Dual network attach

The gateway reads two Docker network names from the environment:

| Variable | Purpose |
|---|---|
| `SPROUT_TRAEFIK_NETWORK` | Network shared with Traefik. Preview **app** containers join this network so Traefik can route traffic via Docker labels. |
| `SPROUT_POSTGRES_NETWORK` | Network shared with Postgres. Gateway, preview **app**, and **seed** containers join this network so they can reach the database by hostname. |

Compose declares both networks with `name: ${SPROUT_…}` so the same variable is the
single source for the Docker network name and the gateway env (defaults are
project-local):

```yaml
networks:
  traefik:
    name: ${SPROUT_TRAEFIK_NETWORK:-sprout-traefik}
  postgres:
    name: ${SPROUT_POSTGRES_NETWORK:-sprout-postgres}
```

When the gateway creates a preview app container it attaches **both** networks.
Seed containers get **Postgres only** — they never need Traefik reachability.

## Traefik coexistence (Coolify and other operators)

sprout does **not** manage Traefik or call the Coolify API. It registers
routes by setting standard [Traefik Docker labels](https://doc.traefik.io/traefik/providers/docker/)
on preview app containers.

To coexist with an **externally managed Traefik** (including Coolify's), use the
overlay instead of forking the reference file:

1. Set `SPROUT_TRAEFIK_NETWORK` / `SPROUT_POSTGRES_NETWORK` in `compose.env` to the
   existing network names (Coolify often uses `traefik`).
2. Ensure those networks exist (`docker network create …` if needed).
3. Bring up **only the gateway** against external networks:

```bash
docker compose -f docker-compose.yml -f docker-compose.external.yml \
  --env-file compose.env up -d --build gateway
```

The overlay marks both networks `external: true` and disables the bundled
`traefik` / `postgres` / `ensure-preview-role` services (via profiles). Point
`SPROUT_PREVIEW_POSTGRES_URL` at the external Postgres admin DSN.

Also set **`SPROUT_PG_HOST`** (and `SPROUT_PG_PORT` if not 5432) to the hostname
preview app and seed containers use to reach Postgres on
`SPROUT_POSTGRES_NETWORK`. That is often different from the host in the admin DSN
(dual-homed setups). The bundled default `postgres` only works when a service
with that DNS name exists on the network.

Create the preview role on the external instance once (the bundled one-shot
does not run under the overlay):

```bash
# From a host that can reach the external Postgres on SPROUT_POSTGRES_NETWORK:
export PGHOST=<hostname-on-postgres-network>   # same as SPROUT_PG_HOST
export PGPORT=5432
export POSTGRES_USER=<admin-user>
export POSTGRES_DB=postgres
export PGPASSWORD=<admin-password>
export SPROUT_PG_USER=sprout_preview
export SPROUT_PG_PASSWORD=<preview-password>
bash deploy/postgres/ensure-preview-role.sh
# Or equivalent: CREATE ROLE sprout_preview LOGIN PASSWORD '…';
```

Also ensure the external Traefik has `--providers.docker=true` and
`--providers.docker.exposedbydefault=false` (or equivalent) so only labelled
containers are published.

Label conventions the gateway applies (v0.1):

- `traefik.enable=true`
- `traefik.http.routers.<name>.rule=Host(\`<hostname>\`)`
- `traefik.http.services.<name>.loadbalancer.server.port=<port>`

Coolify-managed Traefik already watches the Docker socket; sprout
preview containers appear alongside Coolify apps as long as they share the
Traefik network.

## Gateway environment

Required today (gateway fails fast if missing):

| Variable | Description |
|---|---|
| `SPROUT_PREVIEW_POSTGRES_URL` | Admin DSN for `CREATE DATABASE` / `DROP DATABASE` |
| `SPROUT_PG_HOST` | Hostname preview containers use for `PGHOST` |
| `SPROUT_PG_USER` | Static preview login; granted ownership of each `sprout_*` database |
| `SPROUT_PG_PASSWORD` | Password preview containers use for `PGPASSWORD` |
| `SPROUT_TRAEFIK_NETWORK` | Docker network name for Traefik-facing containers |
| `SPROUT_POSTGRES_NETWORK` | Docker network name for database reachability |
| `SPROUT_REGISTRY_URL` | Registry host for pulling preview images |

Optional forge credentials for sweep open-PR / open-MR listing (empty at boot
is allowed; required when sweep calls that forge). Forge kind is chosen
**per repo** from the canonical repo URL (`github.com` → GitHub,
`gitlab.com` → GitLab) or `SPROUT_FORGE_HOSTS` for self-managed GitLab hosts —
not from a gateway-wide forge switch:

| Variable | Description |
|---|---|
| `SPROUT_GITHUB_TOKEN` | GitHub PAT for sweep |
| `SPROUT_GITLAB_TOKEN` | GitLab PAT for sweep |
| `SPROUT_FORGE_HOSTS` | Optional `host=gitlab` pairs (comma-separated), e.g. `git.example.com=gitlab` |
| `SPROUT_FORGE` | **Deprecated.** Single-forge fallback selector (`github` or `gitlab`) |
| `SPROUT_FORGE_TOKEN` | **Deprecated.** Fallback PAT when the matching per-forge token is unset |

Optional registry auth (empty = anonymous pulls — real registry mode, not a
sentinel string):

| Variable | Description |
|---|---|
| `SPROUT_REGISTRY_USER` | Registry username |
| `SPROUT_REGISTRY_PASSWORD` | Registry password or token |

Additional v0.1 variables:

| Variable | Description |
|---|---|
| `SPROUT_PG_PORT` | Port preview containers use for `PGPORT` (default `5432`) |
| `SPROUT_ADMIN_TOKEN` | Bootstrap admin bearer token; auto-generated if omitted or blank — only a non-empty value pins the token |
| `SPROUT_STATE_DB_PATH` | SQLite path (use a volume mount in production) |

Optional tuning (defaults in parentheses):

| Variable | Default |
|---|---|
| `SPROUT_PORT` | `7331` |
| `SPROUT_TTL_HOURS` | `72` |
| `SPROUT_SWEEP_MINUTES` | `30` |
| `SPROUT_PREVIEW_PORT_DEFAULT` | `8080` |
| `SPROUT_SEED_TIMEOUT` | `180` |

See `.env.example` (host gateway / `bun run dev`) and `compose.env.example`
(compose stack). Keep `POSTGRES_*` and `SPROUT_PREVIEW_POSTGRES_URL` in sync in
`compose.env`; do not synthesize the DSN from the raw password in YAML.

## Postgres preview role

The compose stack runs a one-shot `ensure-preview-role` service after Postgres
is healthy. It executes `deploy/postgres/ensure-preview-role.sh` over TCP
(stock `postgres` image entrypoint stays PID 1 — no custom supervisor). The
script creates or `ALTER`s the static preview login (`SPROUT_PG_USER` /
`SPROUT_PG_PASSWORD`) using `format(... %I … %L)` so special characters in the
password are safe. Changing `SPROUT_PG_PASSWORD` and re-running the one-shot
(`docker compose --env-file compose.env run --rm ensure-preview-role`) updates
the role password without recreating the data volume.

The gateway preview-db module grants that role access when it creates each
`sprout_<slug>_pr<id>` database.

## Bootstrap admin token

After first boot, read the admin token from gateway logs if you left
`SPROUT_ADMIN_TOKEN` unset or blank in `compose.env`:

```bash
docker compose --env-file compose.env logs gateway | grep -i admin
```

Create a **deploy token** for each adopting repo:

```bash
export SPROUT_URL=http://127.0.0.1:7331
export SPROUT_TOKEN=<admin-token>
sprout admin token create --scope deploy --repo https://github.com/org/repo
```

Store the deploy token in the adopting repo's CI secrets as `SPROUT_TOKEN`.

## Smoke checklist

`POSTGRES_PASSWORD` and the password embedded in `SPROUT_PREVIEW_POSTGRES_URL` are
two spellings of one secret — keep them identical in `compose.env`. Drift is a
known risk of this dual-write; catch it with the login vs redacted-URL check
below.

| Check | Command |
|---|---|
| Postgres healthy | `docker compose --env-file compose.env ps postgres` |
| Preview role synced | `docker compose --env-file compose.env ps -a ensure-preview-role` (exited 0) |
| Gateway healthy | `curl -sf http://127.0.0.1:7331/healthz` |
| Admin password not drifted | `psql` login with `POSTGRES_*` succeeds **and** gateway startup log `configSummary` redacted `previewPostgresUrl` shows the same user/host/db as `SPROUT_PREVIEW_POSTGRES_URL` (password masked as `***`). If only one of `POSTGRES_PASSWORD` / DSN password was changed, admin SQL fails while the other still works. |
| Networks exist | `docker network inspect sprout-traefik sprout-postgres` |
| Traefik sees Docker | `docker compose --env-file compose.env logs traefik \| tail` |
| No Postgres secrets in gateway | `docker compose --env-file compose.env exec gateway printenv POSTGRES_PASSWORD` — empty / unset |

## See also

- [Adoption guide](adoption.md) — `.sprout.yaml`, CI workflows, app entrypoint
- `examples/adopting-repo/` — copy-paste adopting-repo files
- [`CONTEXT.md`](../CONTEXT.md) — domain vocabulary
- [Spec #12](https://github.com/simpros/sprout/issues/12) — normative v0.1 specification
