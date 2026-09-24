# Previews

One pull request gets at most one preview per adopting repo: its preview
database and, when configured, its preview app container plus optional
companion **service** containers that share the same preview database.
This page owns the lifecycle: database providers, seeding, services, mail.

- Manifest keys? See [Adopting a repo](adopting-a-repo.md).
- CI wiring? See [CI integration](ci-integration.md).
- Operator side (networks, sweep config)? See [Operator deploy](operator-deploy.md).

## Preview lifecycle

`create → migrate (app) → seed (optional) → hand over → drop`:

- PR opened / synchronize → `sprout deploy`: `CREATE DATABASE`
  `sprout_<slug>_pr<id>`, start app container + Traefik `Host` labels,
  optional seed image after the health check.
- PR closed → `sprout teardown`: stop app / seed / services, `DROP DATABASE`.
- Missed teardown is recovered by the gateway **sweep**: periodic
  reconciliation of registered previews vs the Postgres catalog, running
  containers, and the forge open-PR list.

Synchronize re-deploys keep the same database; only a reset wipes it.

## Preview database roles (`db.roles`)

Postgres previews run with one (`single`) or two (`dual`) database
LOGINS. `single` is the owner only; `dual` adds the per-database
restricted companion (`<dbName>_app`, injected as `PGAPPUSER` /
`PGAPPPASSWORD`, remappable via `preview.env`). The default is
derived — `dual` when `preview.env` remaps a companion key, else
`single` — and an explicit `db.roles` wins. Manifest keys, the
contradiction guard, and the RLS recipe live in
[Adopting a repo](adopting-a-repo.md#connection-env-names-roles-reservation-port).

## Service images: merge, leave, clear, lifecycle

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
`preview.services[].env` adds literal service-only variables on top of
that connection env (gateway connection keys win on collision; nothing
leaks into the app container).
Services are force-removed on **teardown** (and on
replace) with the app. The health gate covers **only the app**: after the
app passes `health.expect`, seed runs (when configured), then companion
services start. There is no per-service health poll in this release.

## Multi-image previews (app + services)

Routing examples only — merge, lifecycle, and health-gate rules live above.

Full-stack previews often need more than one long-lived container sharing the
same preview database (API + worker, web + secondary service, etc.). With
`sprout ci preview` pass repeatable `--service name=image`. Low-level deploys
use the same flag:

```bash
sprout deploy -i "$APP_IMAGE" \
  --service api=ghcr.io/org/api:${SHA} \
  --service worker=ghcr.io/org/worker:${SHA}
```

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

- `hostname` — `Host(…)` (supports `{pr_id}` like the app hostname).
- `path` — `PathPrefix(…)`; combined with `Host` via `&&`. Path-only uses
  the app hostname.
- `port` — Traefik `server.port` override. Wins over the image's first
  `EXPOSE`d port; without it behaviour is unchanged
  (first `EXPOSE` → `SPROUT_PREVIEW_PORT_DEFAULT`).
- `env` — literal service-only env (`NAME: value` strings, no `generate:` /
  `required:` kinds). Lands in the service container only.

Mailpit worked example (the image exposes `1025, 1110, 8025` in that
order, so the UI needs an explicit port):

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  services:
    - name: mailpit
      hostname: "mailpit-pr-{pr_id}.myapp.preview.example.com"
      port: 8025
      env:
        MP_SMTP_AUTH_ACCEPT_ANY: "1"
```

```bash
sprout deploy -i "$APP_IMAGE" \
  --service mailpit=axllent/mailpit:latest
```

#### Preview labels: adopter-supplied container labels


`preview.labels` adds literal `key: value` string labels to the app
container **and** every service container; `preview.services[].labels`
adds to that service container only (same key at both levels resolves to
the per-service value). Labels are orthogonal to routing, so internal
(unrouted) services receive them too. The one-shot seed container never
carries adopter labels. Values are literal only — no `{pr_id}`
interpolation.

Worked example — attach the `api` service to a Traefik middleware defined
outside the gateway (file provider) and tag every preview container for
the backup tooling that selects containers by label:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  labels:
    com.example.backup: "true"
  services:
    - name: api
      image: ghcr.io/me/api:latest
      labels:
        traefik.http.routers.api-pr.middlewares: "my-sso@file"
```

Every other key passes through verbatim, `traefik.*` included. The
gateway's own keys are reserved: a deploy whose adopter key matches a
gateway-emitted label for that container fails fast with
`reserved_preview_label`, quoting the manifest path
(`preview.labels.traefik.enable`,
`preview.services[0].labels.traefik.http.routers.sprout-myapp-pr-42.rule`).
The reserved set is derived from the gateway's label emission, so it
tracks the TLS and forwardAuth policy of that gateway. Malformed keys,
non-string values, and empty values fail at manifest parse with named
errors in the existing style.

## Seed run order and resume

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
[Troubleshooting](troubleshooting.md).

## After-healthy hook (seed image)

Run-order flow and low-level examples only — ordering, resume, timeout, and
failure outcomes are contract above and in
[Troubleshooting](troubleshooting.md).

The gateway's only post-startup timing hook is **after-healthy**: once the
preview app passes `health.expect`, an optional **seed image** runs. That is
how you sequence "migrate in the app, then seed" with zero API-code changes.

With the component you declare it once in `.sprout.yaml` and
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

## SQLite previews

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
file is the database; likewise a `single` Postgres preview injects no
`PGAPP*`). There is no gateway tooling that copies a
Postgres preview into a SQLite volume in this release.

Operators: a gateway that only serves SQLite previews needs no Postgres
env at all (`SPROUT_PREVIEW_POSTGRES_URL`, `SPROUT_PG_HOST/USER/PASSWORD`,
`SPROUT_POSTGRES_NETWORK` are required only for `postgres` deploys). A
`postgres` deploy on such a gateway fails fast with
`postgres_not_configured`, naming the repo and the missing variables.

## No-database previews

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

## Email from a preview

Previews can send mail through a gateway-configured Mailpit. The operator
owns the Mailpit instance and the `SPROUT_MAIL_*` gateway variables (see
[Operator deploy](operator-deploy.md#preview-mail-mailpit)); the adopter owns
only the `mail:` block and the `preview.env` remap. Mail works on any
`db.provider` — `postgres`, `sqlite`, and `none` — and needs no
provisioning, health gate, or lifecycle: the gateway only injects env and
joins a network.

What the app receives (canonical names, injected into app, companion
service, and seed containers):

```
MAILHOST  MAILPORT  MAILFROM  MAILFROMNAME  MAILREPLYTO
MAILUSER  MAILPASSWORD  (only when the operator configures credentials)
MAILSECURE              (only when true, as the string "true")
MAILUIURL               (only when the operator configures an inbox URL)
```

`preview.env` renames these exactly like the `PG*` set: unmapped keys
keep their canonical name; a remap replaces the name (no dual alias).
Gateway mail keys win over colliding `preview.app_env` keys — do not put
`MAILHOST` or a remapped name into `SPROUT_APP_ENV`. Worked remap for an
app that speaks `SMTP_*`:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  env:
    MAILHOST: SMTP_HOST
    MAILPORT: SMTP_PORT
    MAILUSER: SMTP_USER
    MAILPASSWORD: SMTP_PASS
```

The entrypoint must read the adopter names (`SMTP_HOST`, …).

The `mail:` block has three postures. Omitted is opportunistic: mail env
is injected when the gateway configures it and silently skipped when it
does not. Explicit `mail: enabled` requires mail: on a gateway without
`SPROUT_MAIL_*` the deploy fails fast with `mail_not_configured`
(`repo <repo> declares mail enabled but the gateway has no mail
configured: missing SPROUT_MAIL_HOST` — same wording from the CLI and
the gateway). `mail: none` opts out: no mail env is injected for that
repo, and the preview never shows the `Mailbox:` note line.

```yaml
mail: enabled   # require mail; fail fast without a configured gateway
mail: none      # opt out even when the gateway configures mail
mail:
  mode: enabled
  from: "noreply+{pr_id}@preview.invalid"   # send-from override (below)
```

An adopter can enable mail with this guide alone: keep the `mail:` block
omitted (or `enabled`), remap `preview.env` onto the app's SMTP names,
deploy, and look for the preview's From address in the inbox linked from
the MR note (`Mailbox:` line).

### Which preview did this mail come from?

Every preview sends from its own address so testers can tell deployments
apart in the shared inbox:

- `MAILFROM` defaults to `<slug>-pr<pr_id>@<from-domain>`, e.g.
  `myapp-pr42@preview.invalid`. `MAILREPLYTO` carries the same address.
- `MAILFROMNAME` is the human label `<slug> PR <pr_id>`
  (e.g. `myapp PR 42`).
- The from-domain is the operator's `SPROUT_MAIL_FROM_DOMAIN` (default
  `preview.invalid`, a reserved suffix that can never deliver real mail).

`mail.from` overrides the address with a `{pr_id}` template using the
same grammar as `preview.hostname` — it must contain `{pr_id}`, support
no other placeholder, contain no whitespace, and read as an address once
`{pr_id}` is substituted. An app that must send from its own convention
points that convention at the preview-identifying address:

```yaml
slug: myapp
preview:
  hostname: "pr-{pr_id}.myapp.preview.example.com"
  env:
    MAILFROM: MAIL_FROM      # app's own from variable reads the identity
mail:
  from: "noreply+{pr_id}@preview.invalid"
```

`mail.from` with `mail: none` is rejected (`mail.from requires mail
enabled`); malformed templates fail at manifest parse (`mail.from …`
naming the problem, e.g. `must contain {pr_id}`).

The MR note and `sprout list` show what to filter for: the note gains
`- Mail from: <address>` alongside `- Mailbox: <inbox-url>`, `sprout
deploy` / `sprout ci preview` print `mail_from=` (and `mailbox_url=`),
and `sprout list` includes `mail_from`, `mail_from_name`, and
`mailbox_url` for previews that received mail env. Inbox recipe: search
the Mailpit UI for the preview's From address, or query the Mailpit API
(`GET /api/v1/messages`) and keep messages whose `From.Address` equals
that address.

### Shared inbox

All previews on one gateway write into one mailbox — there is no
per-preview isolation. Testers tell mail apart by the recipient / From /
subject convention above, not by separate inboxes. If previews must not
see each other's mail at all, run a second Mailpit plus a second gateway
pointed at it; one gateway holds exactly one mail configuration.

## See also

- [Adopting a repo](adopting-a-repo.md) — manifest reference
- [CI integration](ci-integration.md) — reset, notes
- [Operator deploy](operator-deploy.md) — networks, mail instance, sweep
- [Troubleshooting](troubleshooting.md) — seed and mail errors
