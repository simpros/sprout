# Preview database providers: Postgres + SQLite behind one port

**Status:** accepted, implemented.

## The noun

`provider` now names the preview-database axis only: the value of
`db.provider` in `.sprout.yaml` (`postgres` | `sqlite`). It never
describes the app-deployment module — the CONTEXT.md avoid list for that
module still stands. At the deploy boundary the axis is resolved once
into a concrete materialization plan (`provider`, `gatewayEnv`,
`volumes`, `appNetworks`, `seedNetworks`); lifecycle and
app-deployment consume the plan and never see raw `DbSpec`. The two
backends are the Postgres adapter and the SQLite volume adapter behind
the `PreviewDb` port, selected up front by the router.

## Decision

- The manifest owns provider selection (`db:` block, default `postgres`),
  not a gateway-wide env switch. One gateway serves both backends at
  once: mixed fleets deploy without operator reconfiguration, and a
  sqlite-only gateway boots with no Postgres env at all.
- `PreviewDb` stays provider-agnostic (`createDatabase(dbName)`).
  `createRoutingPreviewDb.forCreate(provider)` is the sole selector;
  adapters trust the router instead of re-validating dispatch.
  `sqlite.ts` implements the port over one named Docker volume per
  preview (`sprout-<slug>-pr-<id>-sqlite`), derived from the logical
  database name. The `index.ts` wiring is the single place that decides
  which adapters exist. A literal single static selection in `index.ts`
  would be a gateway-wide switch, which the manifest-owned selection
  above rules out.
- Provider is state: the preview row carries `db_provider` (default
  `"postgres"`), written at claim time. Teardown and sweep route drops
  from the stored provider (`forDrop`); only row-less sweep orphans
  fall back to broadcast, which aggregates real failures instead of
  surfacing the first. The merged catalog dedups on `dbName`, since
  both backends share one name space. A provider switch redeploys as a
  fresh generation: bring-up drops the old backend first, then creates
  the new one, so no resource strands.
- The canonical SQLite key is `DATABASE_URL` with value
  `file:<db.path>/<db.file>`, remappable through `preview.env` under the
  ADR-0007 grammar (remap replaces the name, no dual alias). SQLite
  previews mount the volume at `db.path` in app, service, and seed
  containers and join the Traefik network only; no `PG*` keys are
  injected for them.
- Gateway boot requires only the Traefik network. Postgres config is an
  all-or-nothing optional (`config.postgres`); a partial Postgres env
  fails boot instead of limping. A `postgres` deploy on a gateway
  without Postgres env fails fast at the deploy route with
  `postgres_not_configured`, naming the repo, the provider, and the
  missing variables. The check lives at deploy time rather than boot
  time because repos onboard dynamically through the API — boot cannot
  know which providers will be declared, and a sqlite-only gateway must
  boot clean. `preview.env` keys are validated against the provider at
  manifest parse and at the deploy route (`PG*` needs `postgres`,
  `DATABASE_URL` needs `sqlite`) through one shared preview-env entry
  point.

## Consequences

- Existing manifests behave exactly as before (default `postgres`, same
  container env, DB names, and networks).
- An app-image replace keeps the SQLite volume (data survives);
  teardown removes it on the same paths that drop a Postgres database.
- `sprout worktree-db` stays Postgres-only; previews without a database
  are a separate change on top of this seam.
