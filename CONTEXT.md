# sprout

sprout gives every pull request of an **adopting repo** its own
**preview database** on a **shared instance**, plus optional preview **app
containers**, orchestrated by a **gateway** the operator deploys once.

## Language

### Gateway & modules

**Gateway**:
The long-running sprout server: provisions preview databases, deploys
preview app containers, runs optional seed jobs, and reconciles drift.
_Avoid_: Sidecar, controller, daemon

**preview-db module**:
The gateway part that creates and drops logical databases on the shared
instance and validates database names.
_Avoid_: Provisioner, database backend

**app-deployment module**:
The gateway part that starts, replaces, and removes preview app containers
and attaches Traefik routing labels.
_Avoid_: Provider, deploy backend, PaaS adapter

### Preview lifecycle

**Preview**:
The complete temporary environment for one pull request: its preview database
and, when configured, its preview app container. One PR has at most one
preview per adopting repo.
_Avoid_: Review app, staging environment

**Preview database**:
The logical Postgres database that belongs to exactly one preview, named
`sprout_<slug>_pr<id>`. Created empty; the preview app migrates it at startup.
_Avoid_: Test database, branch database, ephemeral db

**Shared instance**:
The single Postgres server that hosts all preview databases for a gateway
deployment. Operator-managed, outside the per-PR lifecycle.
_Avoid_: Preview cluster, per-PR postgres

**Sweep**:
The gateway's periodic reconciliation pass: compares registered previews,
the Postgres catalog, running containers, and the forge's open-PR list, then
corrects drift.
_Avoid_: GC, cron job, cleanup job

### Identity & naming

**PR id**:
The forge's stable pull-request (or merge-request) number for one preview.
_Avoid_: Branch name as id

**Canonical repo id**:
The full URL-style forge identity for a repository, e.g.
`https://github.com/org/repo`. Used for auth, sweep, and state keys.
_Avoid_: org/repo (ambiguous across forges)

**slug**:
A short adopting-repo alias from `.sprout.yaml` used in hostnames and
database names.
_Avoid_: App name, project key

### Adoption

**Adopting repo**:
A repository that uses sprout for its previews via CI and
`.sprout.yaml`.
_Avoid_: Client repo, tenant repo

**.sprout.yaml**:
The config-as-code file in an adopting repo: slug, preview hostname template,
and optional health-check settings.
_Avoid_: previewdb.yml, pb config

**Seed image**:
A one-shot container image built by the adopting repo's CI, run by the
gateway after the preview app is healthy, to populate the preview database.
_Avoid_: Seeder image, seed container (use "seed image")

**After-healthy hook**:
The post-startup timing hook that runs once `health.expect` passes. In v0.1
the only implementation is the optional seed image (`sprout deploy -s`).
_Avoid_: after-startup hook, post-migrate hook (prefer "after-healthy")

### Clients & access

**sprout**:
The CLI that talks to the gateway API (`deploy`, `teardown`, `list`, etc.).
_Avoid_: preview-buddy CLI, pbuddy

**Deploy token**:
A bearer credential scoped to one canonical repo id; used from adopting-repo
CI for `deploy` and `teardown`.
_Avoid_: API key (generic), repo secret

**Admin token**:
A bearer credential with operator scope: token management, `list`, `doctor`,
`drop`, and sweep configuration.
_Avoid_: Root token, master key

## See also

- The normative v0.1 specification (tracked in the GitHub issue tracker)
- `docs/adr/` — architecture decision records
- `docs/agents/` — how agents consume this documentation
