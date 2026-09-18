# Preview database providers: Postgres + SQLite behind one port

**Status:** accepted, implemented.

## The noun

`provider` now names the preview-database axis only: the value of
`db.provider` in `.sprout.yaml` (`postgres` | `sqlite`). It never
describes the app-deployment module — the CONTEXT.md avoid list for that
module still stands. In gateway code the axis travels as `DbSpec`
(`provider`, `path`, `file`); the two backends are the Postgres adapter
and the SQLite volume adapter behind the existing `PreviewDb` port.

## Decision

- The manifest owns provider selection (`db:` block, default `postgres`),
  not a gateway-wide env switch. One gateway serves both backends at
  once: mixed fleets deploy without operator reconfiguration, and a
  sqlite-only gateway boots with no Postgres env at all.
- `PreviewDb` stays the port. `postgres.ts` keeps its signature (plus an
  optional `DbSpec` it only guards on); `sqlite.ts` implements the same
  port over one named Docker volume per preview
  (`sprout-<slug>-pr-<id>-sqlite`), derived from the logical database
  name. The `index.ts` wiring is the single place that decides which
  adapters exist; per-deploy dispatch on the manifest's `db.provider`
  lives in the seam itself (`routing.ts` for database create/drop/list,
  `preview/runtime.ts` for container env, mounts, and networks), so
  lifecycle and app-deployment code only forwards `db` and never
  branches on it. A literal single static selection in `index.ts` would
  be a gateway-wide switch, which the manifest-owned selection above
  rules out.
- `routing.ts` broadcasts `dropDatabase` across backends (both drops
  are missing-tolerant — `DROP … IF EXISTS`, 404-tolerant volume
  remove — so the absent side no-ops and only real failures throw),
  which keeps teardown and sweep provider-agnostic.
- The canonical SQLite key is `DATABASE_URL` with value
  `file:<db.path>/<db.file>`, remappable through `preview.env` under the
  ADR-0007 grammar (remap replaces the name, no dual alias). SQLite
  previews mount the volume at `db.path` in app, service, and seed
  containers and join the Traefik network only; no `PG*` keys are
  injected for them.
- Gateway boot requires only the Traefik network. A `postgres` deploy on
  a gateway without Postgres env fails fast at the deploy route with
  `postgres_not_configured`, naming the repo, the provider, and the
  missing variables. The check lives at deploy time rather than boot
  time because repos onboard dynamically through the API — boot cannot
  know which providers will be declared, and a sqlite-only gateway must
  boot clean. `preview.env` keys are validated against the provider at
  manifest parse and at the deploy route (`PG*` needs `postgres`,
  `DATABASE_URL` needs `sqlite`).

## Consequences

- Existing manifests behave exactly as before (default `postgres`, same
  container env, DB names, and networks).
- An app-image replace keeps the SQLite volume (data survives);
  teardown removes it on the same paths that drop a Postgres database.
- `sprout worktree-db` stays Postgres-only; previews without a database
  are a separate change on top of this seam.
