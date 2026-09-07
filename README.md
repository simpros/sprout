# sprout

Per-PR **preview databases** (and optional preview app containers) for
self-hosted deployments.

When a pull request opens, CI calls the sprout **gateway**, which
provisions an isolated **logical database** on a shared Postgres instance,
starts a preview app container, optionally runs a seed image, and tears
everything down when the PR closes.

```
create → migrate (app) → seed (optional) → hand over → drop
```

## Why

Preview deployments often share one database with production or with each
other. Migrations in previews then mutate shared state. sprout gives
every PR its own database on a single shared Postgres — low overhead, full
data isolation per PR.

## How

1. Operator deploys **Postgres** + the **gateway** + **Traefik** via
   [Docker Compose](docs/deploy.md) once.
2. Adopting repo adds `.sprout.yaml` and a CI workflow — see the
   [adoption guide](docs/adoption.md) and
   [`examples/adopting-repo/`](examples/adopting-repo/).
3. Gateway **preview-db module** creates `prev_<slug>_pr<id>` on the shared
   instance.
4. Gateway **app-deployment module** runs the app container with Traefik
   labels on a shared reverse-proxy network (works alongside Traefik managed
   by Coolify or elsewhere — no Coolify API integration).
5. App image runs migrations at startup; optional **seed image** (built by
   the same CI job) populates data after the app is healthy.
6. **Sweep** reconciles drift if CI teardown is missed.

Auth: deploy tokens for CI, admin tokens for operators. Gateway state in
SQLite. The normative v0.1 specification is tracked in the GitHub issue tracker.

## Docs

- `CONTEXT.md` — domain vocabulary
- [`docs/deploy.md`](docs/deploy.md) — operator compose stack (Postgres + gateway + Traefik)
- [`docs/adoption.md`](docs/adoption.md) — adopting-repo guide (yaml, CI, entrypoint)
- [`examples/adopting-repo/`](examples/adopting-repo/) — copy-paste example files
- [`e2e/`](e2e/) — acceptance harness against compose (`bun run test:e2e`)
- Spec — normative v0.1 specification (tracked in the GitHub issue tracker)
- `docs/adr/` — architecture decisions

## Status

🚧 v0.1 in progress — specification adopted; implementation catching up.
