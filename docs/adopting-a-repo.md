# Adopting a repo

`.sprout.yaml` is the config-as-code file in an adopting repo: slug, preview
hostname template, optional health-check settings, optional companion service
routing metadata, optional `build` / `seed` image blocks, optional `db`
provider block, and computed env values. This page is the contract.

- First preview? Start in [Getting started](getting-started.md).
- CI wiring for your forge? See [CI integration](ci-integration.md).
- Lifecycle (databases, seeding, services, mail)? See [Previews](previews.md).
- Commands and debugging? See [CLI reference](cli-reference.md).

Copy-paste app files live in
[`examples/adopting-repo/README.md`](../examples/adopting-repo/README.md).

## Manifest keys (`.sprout.yaml`)

The CLI reads this file locally and sends parsed values to the gateway.
Unknown keys are rejected (`unknown key: <path>`). This table is the
contract; the notes directly below it (connection env, value grammar, merge
order) are part of the contract. Seeding order lives in
[Previews](previews.md#seed-run-order-and-resume), service merge rules in
[Previews](previews.md#service-images-merge-leave-clear-lifecycle), mail in
[Previews](previews.md#email-from-a-preview). Test
pointers live in [CLI reference](cli-reference.md#test-coverage-maintainers).

| Key | Required | Default | Purpose |
|---|---|---|---|
| `slug` | yes | — | Short name used in database names (`sprout_<slug>_pr<id>`) and container names. Alphanumeric. |
| `preview.hostname` | yes | — | Per-PR host template. Must contain `{pr_id}`; no scheme, port, path, or other placeholders. The CLI owns substitution and prints `preview_url=` — CI never reconstructs it. |
| `preview.env` | no | canonical `PG*` (+ `PGAPP*` in `dual`) (`postgres`) or `DATABASE_URL` (`sqlite`); rejected on `none` | Rename injected connection env (see Connection env). |
| `preview.app_env` | no | — | Extra app env (see Value grammar, Merge order, Connection env reservation). |
| `preview.services` | no | leave companions | Companion routing entries (see [Previews](previews.md#service-images-merge-leave-clear-lifecycle)). |
| `preview.services[].name` | per entry | — | Service name (validated, unique). |
| `preview.services[].image` | per entry unless `--service` | — | Pinned image for the service. |
| `preview.services[].hostname` | no | internal-only | Distinct `Host()` for the service. |
| `preview.services[].path` | no | internal-only | `PathPrefix()` for the service (must start with `/`). |
| `preview.services[].port` | no | image first `EXPOSE`, else `SPROUT_PREVIEW_PORT_DEFAULT` | Routed port override (integer 1–65535). Only sets the Traefik `server.port` label when the service is routed; accepted for internal services with no routing effect. |
| `preview.services[].env` | no | — | Literal `NAME: value` string map injected into the service container only (keys must match `[A-Za-z_][A-Za-z0-9_]*`). |
| `preview.labels` | no | — | Adopter container labels applied to the app container and every service container (see [Preview labels](previews.md#preview-labels-adopter-supplied-container-labels)). |
| `preview.services[].labels` | no | — | Adopter container labels for that service container only; same key at both levels resolves to the per-service value (see [Preview labels](previews.md#preview-labels-adopter-supplied-container-labels)). |
| `db.provider` | no | `postgres` | Preview database provider: `postgres` (shared instance), `sqlite` (named volume), or `none` (no database). See [Previews](previews.md#sqlite-previews) and [Previews](previews.md#no-database-previews). |
| `db.roles` | no | derived: `dual` when `preview.env` remaps `PGAPPUSER` / `PGAPPPASSWORD`, else `single` | Postgres credential axis: `single` (owner only) or `dual` (owner + restricted companion). Rejected on `sqlite` / `none`. Explicit `single` plus a companion remap fails fast. |
| `mail` | no | opportunistic (follows the gateway) | `enabled` (require mail) or `none` (opt out). See [Previews](previews.md#email-from-a-preview). |
| `mail.from` | no | `<slug>-pr<pr_id>@<from-domain>` | Send-from override; must be an address template containing `{pr_id}` (only that placeholder). Rejected with `mail: none`. See [Previews](previews.md#email-from-a-preview). |
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

### Connection env: names, roles, reservation, port

The gateway injects these connection variables into preview app, service,
and seed containers. Which set you get follows `db.provider`:

Postgres (`db.provider: postgres`, the default):

```
PGHOST  PGPORT  PGUSER  PGPASSWORD  PGDATABASE
PGAPPUSER  PGAPPPASSWORD   (dual only — see db.roles below)
```

`db.roles` selects the Postgres credential axis (`single` | `dual`,
Postgres only; rejected on `sqlite` / `none`). `dual` provisions the
restricted companion role and injects `PGAPPUSER` / `PGAPPPASSWORD`
exactly as before; `single` provisions no companion and injects neither
name anywhere. The default is derived: `dual` when `preview.env`
remaps `PGAPPUSER` or `PGAPPPASSWORD`, otherwise `single` — an adopter
who never mentions the companion never gets one, and existing remap
users keep working with zero config change. An explicit `db.roles`
wins over the derivation, and explicit `db.roles: single` plus a
companion remap fails fast at manifest parse and at the deploy route
(`preview.env.<KEY> conflicts with db.roles single`).

SQLite (`db.provider: sqlite`):

```
DATABASE_URL=file:<db.path>/<db.file>   (default file:/data/preview.db)
```

No-database (`db.provider: none`): no connection variables are injected
at all — every `preview.env` entry is rejected at manifest parse
(`preview.env.PGHOST requires db.provider postgres`) and at the gateway
deploy route, and a `seed:` block is rejected the same way
(`seed requires db.provider postgres or sqlite (db.provider is none)`).
See [Previews](previews.md#no-database-previews) for the lifecycle.

No `PG*` keys are injected for a SQLite preview, and no `DATABASE_URL`
for a Postgres one — `preview.env` entries for the other backend fail at
manifest parse (`preview.env.PGHOST requires db.provider postgres`).
See [Previews](previews.md#sqlite-previews) for the volume behaviour.

- **Owner** (`PGUSER` / `PGPASSWORD`): the static preview login
  (`SPROUT_PG_USER`). Owns each preview database — use this for migrations.
- **Restricted companion** (`PGAPPUSER` / `PGAPPPASSWORD`, `dual` only):
  a per-preview LOGIN named `<dbName>_app` with `CONNECT` and schema
  `USAGE` only. Password is derived by the gateway (stable for the life
  of the preview). Use this for RLS-constrained runtime queries. Do not
  `CREATE ROLE` — the gateway already provisioned it; `GRANT` table
  privileges to this role instead. `single` previews have no such role
  and inject neither name.

`preview.env` renames the gateway-injected connection names. Unmapped keys
stay canonical; a remap replaces the name (no dual alias). The entrypoint
must read the adopter names.

Gateway connection keys replace colliding adopter keys (canonical `PG*` ∪
remapped names after `preview.env`) — same policy for app and seed env.
Do not put `PGHOST` or a remapped name into `SPROUT_APP_ENV`: the gateway
strips it in favour of its own value and the app silently gets the
gateway's connection, not yours.

Port: the gateway routes to the service `port` override when set,
else the first `EXPOSE`d port in the app image,
else `SPROUT_PREVIEW_PORT_DEFAULT`. Teardown drops the database and then
the companion role when one was provisioned (`dual`; a `dual`-era role
is still dropped after the repo flips to `single`).

Mail is cross-provider: on a gateway with mail configured, every preview
(app, companions, seed) also receives the canonical `MAIL*` set, on any
`db.provider` including `none`. The canonical names, the remap worked
example, and the opt-out live in exactly one place —
[Previews](previews.md#email-from-a-preview).

### Env value grammar

`preview.app_env` / `seed.env` values are a plain string, `{ generate:
stable_per_pr }`, or `{ required: true }`. Strings may interpolate
`{hostname}`, `{pr_id}`, `{commit_sha}` (`{commit_sha}` follows the forge
SHA, `CI_COMMIT_SHA` on GitLab / `GITHUB_SHA` on GitHub). `generate`
derives a per-MR secret (HMAC of repo, MR, key, keyed by the deploy token
— keep the token stable for the MR lifetime). `required` must be supplied
by CI; missing keys fail before the gateway call naming the key.

### Env merge order

App: yaml first, then `SPROUT_APP_ENV` / each `--app-env-file` in order,
then `--app-env` flags (later wins per key). Seed: yaml first, then
`SPROUT_SEED_ENV` / each `--seed-env-file` in order, then `--seed-env`
flags. Seed args: yaml `seed.args` first, then `--seed-arg` flags
appended.

Minimal app-only manifest (defaults apply):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
```

Seeded manifest (as in the quickstart): add `health:` + `seed:`. `seed: {}`
alone enables seeding with the conventional `Dockerfile.seed`.

## App image: migrate at startup

Contract above is normative; this section is entrypoint examples only.
Connection names, owner/companion roles, and the port rule live in
Connection env — snippets below assume the default `PG*` map (`dual`
adds `PGAPP*`; `single` omits them).

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

Set `db.roles: dual` for product databases that use a privileged owner
+ restricted RLS role — previews then work without cluster `CREATEROLE`
on the preview login (without the flag there is no companion role and
no `PGAPP*` names to read):

1. Migrate with `PGUSER` / `PGPASSWORD` (owner).
2. `GRANT` the needed table/sequence privileges to the role in `PGAPPUSER`
   (and enable RLS / policies as in production).
3. Open the app pool with `PGAPPUSER` / `PGAPPPASSWORD` (remap via
   `preview.env` if that matches your product env names).

### Extra app env (non-connection)

Example only — grammar, merge order, and the gateway reservation rule
live above. Adopters often need runtime env beyond the connection fields
(`BETTER_AUTH_SECRET`, app URLs, trusted origins, etc.): pass those as
`preview.app_env` / `seed.env` in `.sprout.yaml`, a masked file-type
`SPROUT_APP_ENV` / `SPROUT_SEED_ENV` dotenv blob, repeatable
`--app-env-file` / `--seed-env-file`, or repeatable `--app-env KEY=VALUE` /
`--seed-env KEY=VALUE`. Forge File-var wiring lives in
[`templates/README.md`](../templates/README.md); placeholders expand in
every layer. File-type CI variables do NOT survive component `inputs:`
expansion — map file-type blobs at job runtime via `variables:`
(`SPROUT_APP_ENV: $MY_ENV_FILE`), never as `app_env_file:` inputs.

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

- [Getting started](getting-started.md) — first preview
- [CI integration](ci-integration.md) — both forges, reset, notes
- [Previews](previews.md) — databases, seeding, services, mail
- [CLI reference](cli-reference.md) — commands, debugging
- [Troubleshooting](troubleshooting.md) — error catalogue
- [Operator deploy](operator-deploy.md) — gateway stack
