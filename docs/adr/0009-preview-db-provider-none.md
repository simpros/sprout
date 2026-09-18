# Previews without a database: `db.provider: none`

**Status:** accepted, implemented.

## The noun

`none` is the third value of the preview-database axis (`db.provider` in
`.sprout.yaml`: `postgres` | `sqlite` | `none`), reusing the provider seam
from the SQLite change. It never describes the app-deployment module —
the CONTEXT.md avoid list for that module still stands. A `none` preview
is app container + optional companion services + routing + health, with
no database at all.

## Decision

- The manifest owns the choice (`db.provider: none`, default stays
  `postgres`), not a gateway-wide switch and not a parallel flag. The
  deploy boundary resolves `none` into a concrete materialization plan
  with empty `gatewayEnv`/`volumes` and Traefik-only networks; lifecycle
  and app-deployment consume the plan and never branch on the provider.
  `forCreate("none")` throws (there is no backend to select), so the
  deploy path calling it is a bug; `forDrop("none")` is a no-op safety
  net, but teardown skips the catalog lock and the drop call entirely.
- `previews.db_name` is **nullable**, not a reserved sentinel. A sentinel
  keeps `NOT NULL` but leaks a fake name into every `db_name` read
  (snapshots, list, sweep, doctor) and risks colliding with the catalog
  namespace; `NULL` renders cleanly (`db_name: null`) and can never match
  a `sprout_<slug>_pr<id>` catalog entry, so sweep TTL, PR-close, status,
  and orphan planning keep working with null-aware comparisons. The
  migration rebuilds the table with `db_name` nullable and copies rows
  verbatim.
- Contradictory combinations fail fast with named errors rather than
  silent no-ops: a `seed:` block or any `preview.env` database-key remap
  combined with `none` is rejected at manifest parse and at the gateway
  deploy route (`seed requires db.provider postgres or sqlite
  (db.provider is none)`; `preview.env.<KEY> requires db.provider
  <home>`), and `-s` / `--reseed` / `sprout ci reseed -s …` fail fast on
  the CLI before any network call. The seed gate reads the provider, so
  no seed phase ever runs for `none`.
- Gateway boot is unchanged (Traefik network only): a gateway whose
  repos are all `none` needs no `SPROUT_*PG*` /
  `SPROUT_POSTGRES_NETWORK`; a `postgres` deploy without them still fails
  fast with `postgres_not_configured`. Provider switching redeploys as a
  fresh generation — the claim intent preserves the old name through the
  switch so bring-up drops the old backend before nulling the column.

## Consequences

- `postgres` and `sqlite` paths are untouched: same container env, DB
  names, volumes, and networks. Companion services work as today minus
  the database env.
- No new CLI flags; `sprout list` and the status endpoint render
  `db_name: null` for `none` previews.
- A test with a throwing `PreviewDb` port proves zero database calls on
  the `none` deploy path by construction, not by review.
