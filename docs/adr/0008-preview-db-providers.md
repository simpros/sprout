# Preview database providers: Postgres, SQLite, none

*Folds ADR-0009: `none` is the third provider value below.*

`db.provider` in `.sprout.yaml` (`postgres` default | `sqlite` | `none`) selects
the backend per repo, not per gateway, so one gateway serves mixed fleets and a
sqlite-only gateway boots without Postgres env. The deploy route resolves the
provider once into a materialization plan; lifecycle and app-deployment consume
the plan and never branch on provider.

- The provider is stored on the preview row. Teardown and sweep drop via the
  stored provider; only row-less orphans fall back to broadcast.
- `previews.db_name` is nullable for `none`. A sentinel name would leak into
  every read and could collide with the catalog namespace.
- Contradictory manifests (`seed` or DB env remaps with `none`, `PG*` with
  `sqlite`) fail fast at manifest parse and at the deploy route.
- Switching provider redeploys as a fresh generation: the old backend is dropped
  before the new one is created.

`db.roles` selects the Postgres credential axis (`single` | `dual`; contract in
`docs/adopting-a-repo.md`, derivation in `resolveDbRoles`). Name validation is
mode-scoped — `dual` reserves budget for the `<dbName>_app` companion role —
while catalog reads stay permissive at the full identifier budget, so flipping
a repo to `single` never makes existing previews unlistable or undeletable and
teardown still drops a companion role left over from `dual`.
