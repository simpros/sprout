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

The gateway is **one image, one process** (root `Dockerfile`), and the image
also embeds the `sprout` CLI (same Bun lockfile / version pin as the gateway)
so operators can `docker exec` against localhost without a host-side install.
Compose builds it via `build: .`; you can also build and tag it alone for
registry push or external orchestrators:

```bash
# From the repo root (reproducible with Bun 1.4.0 base + frozen lockfile)
docker build -t ghcr.io/simpros/sprout:0.2.1 \
  --build-arg SPROUT_VERSION=0.2.1 \
  .
# Optional: push after docker login to GHCR (or your registry)
# docker push ghcr.io/simpros/sprout:0.2.1
```

Image label `org.opencontainers.image.version` mirrors `SPROUT_VERSION` (default
`0.2.1`). Pin operators and CI to an image built from this branch or the
`v0.2.1` release tag when published.

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
| Bootstrap admin token file | `SPROUT_ADMIN_TOKEN_PATH` (`/data/admin-token` compose/image; `admin-token` host default); mode `0600` |
| Traefik network | `sprout-traefik` |
| Postgres network | `sprout-postgres` |
| Preview Postgres roles | `sprout_admin` / `sprout_preview` |
| Preview container names | `sprout-<slug>-pr-<id>` |
| Preview database names | `sprout_<slug>_pr<id>` |

Upgrading from legacy `preview-buddy*` / `pb*` / `prev_*` defaults is a
**wipe-and-redeploy**: tear down volumes, networks, and control-plane state,
then bring the stack up again. There is no in-place migrator. Pin
`SPROUT_TRAEFIK_NETWORK` / `SPROUT_POSTGRES_NETWORK` / `SPROUT_STATE_DB_PATH` /
`SPROUT_ADMIN_TOKEN_PATH` (and role env vars) only when you intentionally use
non-default names (external Traefik, Coolify, etc.).

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
2. For HTTPS routers, set Traefik TLS knobs to match that proxy — e.g.
   `SPROUT_TRAEFIK_ENTRYPOINTS=https` and optionally
   `SPROUT_TRAEFIK_CERTRESOLVER=letsencrypt` on Coolify. Leave both unset for
   HTTP-only Traefik (bundled compose / local). Empty entrypoints keeps TLS off
   even if certresolver is set.
3. Ensure those networks exist (`docker network create …` if needed).
4. Bring up **only the gateway** against external networks:

```bash
docker compose -f docker-compose.yml -f docker-compose.external.yml \
  --env-file compose.env up -d --build gateway
```

The overlay marks both networks `external: true` and disables the bundled
`traefik` / `postgres` services (via profiles). Point
`SPROUT_PREVIEW_POSTGRES_URL` at the external Postgres admin DSN.

Also set **`SPROUT_PG_HOST`** (and `SPROUT_PG_PORT` if not 5432) to the hostname
preview app and seed containers use to reach Postgres on
`SPROUT_POSTGRES_NETWORK`. That is often different from the host in the admin DSN
(dual-homed setups). The bundled default `postgres` only works when a service
with that DNS name exists on the network.

The gateway creates or syncs the preview login (`SPROUT_PG_USER` /
`SPROUT_PG_PASSWORD`) on boot from the admin DSN — no manual `CREATE ROLE` and
no compose one-shot. The admin role needs `CREATEROLE` (or superuser); otherwise
boot fails with a clear error.

Also ensure the external Traefik has `--providers.docker=true` and
`--providers.docker.exposedbydefault=false` (or equivalent) so only labelled
containers are published.

Label conventions the gateway applies (v0.1):

- `traefik.enable=true`
- `traefik.http.routers.<name>.rule=Host(\`<hostname>\`)`
- `traefik.http.services.<name>.loadbalancer.server.port=<port>`

When TLS is enabled (`SPROUT_TRAEFIK_ENTRYPOINTS` non-empty), also:

- `traefik.http.routers.<name>.tls=true`
- `traefik.http.routers.<name>.entrypoints=<SPROUT_TRAEFIK_ENTRYPOINTS>`
- `traefik.http.routers.<name>.tls.certresolver=<SPROUT_TRAEFIK_CERTRESOLVER>`
  (only when certresolver is set)

TLS is opt-in: unset/blank entrypoints → HTTP labels only (works with the
bundled Traefik `web` entrypoint). Entrypoints without certresolver uses
Traefik's default/builtin cert. Entrypoint and certresolver names are **not**
Coolify-specific — set them to match your Traefik (e.g. Coolify often uses
`https` + `letsencrypt`; stock Traefik quickstarts often use `websecure` + a
custom resolver name).

Coolify-managed Traefik already watches the Docker socket; sprout
preview containers appear alongside Coolify apps as long as they share the
Traefik network.

## Gateway environment

Required today (gateway fails fast if missing):

| Variable | Description |
|---|---|
| `SPROUT_PREVIEW_POSTGRES_URL` | Admin DSN for role ensure, `CREATE DATABASE`, `DROP DATABASE` (needs `CREATEROLE` or superuser) |
| `SPROUT_PG_HOST` | Hostname preview containers use for `PGHOST` |
| `SPROUT_PG_USER` | Static preview login; gateway ensures it exists; granted ownership of each `sprout_*` database |
| `SPROUT_PG_PASSWORD` | Password preview containers use for `PGPASSWORD` (synced onto the role on every gateway boot) |
| `SPROUT_TRAEFIK_NETWORK` | Docker network name for Traefik-facing containers |
| `SPROUT_POSTGRES_NETWORK` | Docker network name for database reachability |

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

Optional registry auth (empty = anonymous pulls — real registry mode, not a
sentinel string). The deploy request carries a fully-qualified `app_image`;
sprout does not take a separate registry host env var. Host `docker login`
does not help gateway-initiated Engine API pulls — set these when images are private.

| Variable | Description |
|---|---|
| `SPROUT_REGISTRY_AUTHS_JSON` | Per-host cred map: `{"ghcr.io":{"username":"u","password":"p"},...}` (Docker AuthConfig field names). Host is parsed from each image ref; unmatched hosts pull anonymously (unless the legacy pair below is set). Malformed JSON fails at boot. |
| `SPROUT_REGISTRY_USER` | Legacy single-registry username (fallback when image host is not in the map) |
| `SPROUT_REGISTRY_PASSWORD` | Legacy single-registry password or token |

Additional v0.1 variables:

| Variable | Description |
|---|---|
| `SPROUT_PG_PORT` | Port preview containers use for `PGPORT` (default `5432`) |
| `SPROUT_ADMIN_TOKEN` | Bootstrap admin bearer token; auto-generated if omitted or blank — only a non-empty value pins the token |
| `SPROUT_STATE_DB_PATH` | SQLite path (use a volume mount in production) |
| `SPROUT_ADMIN_TOKEN_PATH` | Raw admin bearer file for in-container CLI fallback (compose/image default `/data/admin-token`) |

Optional tuning (defaults in parentheses):

| Variable | Default |
|---|---|
| `SPROUT_PORT` | `7331` |
| `SPROUT_TTL_HOURS` | `72` |
| `SPROUT_SWEEP_MINUTES` | `30` |
| `SPROUT_PREVIEW_PORT_DEFAULT` | `8080` |
| `SPROUT_SEED_TIMEOUT` | `180` |
| `SPROUT_TRAEFIK_ENTRYPOINTS` | _(empty — TLS off, HTTP labels only)_ |
| `SPROUT_TRAEFIK_CERTRESOLVER` | _(empty — omit; only used when entrypoints set)_ |

For HTTPS behind an external Traefik, set entrypoints (and optionally
certresolver) to that proxy's names. Example Coolify-shaped values (operator
choice, not sprout defaults): `SPROUT_TRAEFIK_ENTRYPOINTS=https` and
`SPROUT_TRAEFIK_CERTRESOLVER=letsencrypt`.

See `.env.example` (host gateway / `bun run dev`) and `compose.env.example`
(compose stack). Keep `POSTGRES_*` and `SPROUT_PREVIEW_POSTGRES_URL` in sync in
`compose.env`; do not synthesize the DSN from the raw password in YAML.

## Postgres preview role

**Fresh Postgres, zero SQL.** Point `SPROUT_PREVIEW_POSTGRES_URL` at a new
instance whose admin has `CREATEROLE` (or is superuser), set
`SPROUT_PG_USER` / `SPROUT_PG_PASSWORD`, start the gateway — no
`CREATE ROLE`, no init scripts, no compose one-shot. Compose no longer ships
an `ensure-preview-role` service; the gateway owns role ensure on boot
(and again before each `CREATE DATABASE`).

If `SPROUT_PG_USER` is missing the gateway runs
`CREATE ROLE … LOGIN PASSWORD …`; if present it
`ALTER ROLE … LOGIN PASSWORD …` so password rotation is
`change SPROUT_PG_PASSWORD` + restart. Role names must match the lowercase
`SAFE_ROLE` guard. Without `CREATEROLE` (or superuser), boot fails with a
clear error instead of a later `CREATE DATABASE … OWNER` failure.

An optional manual helper remains at
`deploy/postgres/ensure-preview-role.sh` for pre-provisioning without starting
the gateway.

The gateway preview-db module grants that role ownership when it creates each
`sprout_<slug>_pr<id>` database, and also creates a per-DB restricted companion
LOGIN (`<dbName>_app`) with `CONNECT` + schema `USAGE`. Containers receive
owner credentials as `PGUSER`/`PGPASSWORD` and companion credentials as
`PGAPPUSER`/`PGAPPPASSWORD` (remappable via `preview.env` — see the adoption
guide). Teardown drops the database then the companion role.

## Worktree DB (local provisioner)

Parallel agents / herdr worktrees on one machine can clash on shared Postgres
credentials. The CLI provisions an isolated DB + LOGIN role per worktree
**without** talking to the gateway:

```bash
sprout worktree-db provision --slug <name> --env-file <path> --admin-url "$ADMIN_DSN"
sprout worktree-db drop --slug <name> --admin-url "$ADMIN_DSN"
```

- **Admin DSN** must allow `CREATEROLE` (or be superuser) — same bar as
  `SPROUT_PREVIEW_POSTGRES_URL`. Role ensure reuses the shared
  `@sprout/preview-db` `#71` algorithm (`CREATE` if missing, else
  `ALTER … PASSWORD`).
- Objects are named `sprout_wt_<key>` (hyphens in the worktree key become
  underscores). `drop` refuses any name outside the `sprout_wt_` prefix.
- Worktree key rule (CLI `--slug`; distinct from adopting-repo **slug**):
  lowercase, `[^a-z0-9-]` → `-`, collapse runs, max 40 characters.
- `provision` is idempotent: a second run re-ensures the role/DB and rewrites
  connection vars in `--env-file` (creates the file if missing; atomic
  temp+rename). When `PGPASSWORD` is already present in the env file, that
  password is reused so live connections are not rotated. Defaults write
  `DATABASE_URL` plus canonical `PGHOST` / `PGPORT` / `PGUSER` /
  `PGPASSWORD` / `PGDATABASE` (ADR-0007); rename with
  `--rename LOGICAL=NAME` (logical keys: `DATABASE_URL`, `PGHOST`, …).

## Bootstrap admin token

On every boot where the raw bearer is known (pinned `SPROUT_ADMIN_TOKEN`, or
first-time auto-generate), the gateway writes it to `SPROUT_ADMIN_TOKEN_PATH`
(mode `0600`). Compose and the gateway image publish
`SPROUT_ADMIN_TOKEN_PATH=/data/admin-token` so the embedded CLI does not guess
from the SQLite path. Later boots with a hashed-only admin require that file to
still be readable (missing/empty → boot fails). When `SPROUT_ADMIN_TOKEN` is
unset or blank on first generate, the raw token is also printed once in gateway
logs:

```bash
docker compose --env-file compose.env logs gateway | grep -i admin
```

Create a **deploy token** for each adopting repo by exec'ing the CLI already
in the gateway image (`SPROUT_URL` defaults to `http://127.0.0.1:7331`).
Against that loopback URL the CLI resolves a bearer as:
`SPROUT_TOKEN` → `SPROUT_ADMIN_TOKEN` → `SPROUT_ADMIN_TOKEN_PATH` (default
`admin-token`; `/data/admin-token` in-container), so bare `docker exec` works
for pinned and auto-generated admin tokens:

```bash
# Primary path: CLI embedded in the gateway image (no SPROUT_TOKEN needed)
docker compose --env-file compose.env exec gateway \
  sprout admin token create --scope deploy --repo https://github.com/org/repo --slug org-repo

# Smoke the embedded CLI (no token / no SPROUT_URL needed)
docker compose --env-file compose.env exec gateway sprout health
```

Host-side CLI against a remote gateway still needs an explicit
`SPROUT_TOKEN` — admin env/file fallback is loopback-only.

Store the deploy token in the adopting repo's CI secrets as `SPROUT_TOKEN`.

## Smoke checklist

`POSTGRES_PASSWORD` and the password embedded in `SPROUT_PREVIEW_POSTGRES_URL` are
two spellings of one secret — keep them identical in `compose.env`. Drift is a
known risk of this dual-write; catch it with the login vs redacted-URL check
below.

| Check | Command |
|---|---|
| Postgres healthy | `docker compose --env-file compose.env ps postgres` |
| Preview role synced | Gateway started cleanly (boot runs `ensurePreviewRole`); or check `psql` can `\du` the `SPROUT_PG_USER` login |
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
