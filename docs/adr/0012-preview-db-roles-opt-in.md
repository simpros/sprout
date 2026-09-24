# Preview DB roles: restricted companion opt-in (`db.roles`)

**Status:** accepted, implemented.

## The noun

`roles` names the Postgres preview-database credential axis only: the
value of `db.roles` in `.sprout.yaml` (`single` | `dual`, Postgres
only). It never describes the app-deployment module or the companion
**service** containers — the CONTEXT.md avoid lists for both still
stand. A `single` preview is one Postgres LOGIN (the static preview
owner); a `dual` preview adds the per-database restricted companion
LOGIN (`<dbName>_app`) exactly as before.

## Decision

- The manifest owns the choice (`db.roles`, Postgres only), not a
  gateway-wide switch and not a parallel flag. `dual` is byte-for-byte
  today's contract: one role named `<dbName>_app`, the same HMAC-derived
  password, the same `GRANT CONNECT` + schema `USAGE`, the same
  `PGAPPUSER` / `PGAPPPASSWORD` names injected into app,
  companion-service, and seed containers, remappable via `preview.env`.
  `single` provisions no companion role and injects no `PGAPPUSER` /
  `PGAPPPASSWORD` anywhere.
- The default is derived by one rule, not two mechanisms: `dual` when
  `preview.env` remaps `PGAPPUSER` or `PGAPPPASSWORD`, otherwise
  `single`. An explicit `db.roles` wins over the derivation. The
  resolver lives in `@sprout/preview-env` (`resolveDbRoles`) and both
  the CLI manifest parse and the gateway deploy route call it — the
  shared-package pattern the provider guard already uses.
- Contradictory combinations fail fast with named errors rather than
  silent disagreement: explicit `db.roles: single` plus a `preview.env`
  entry for a companion key is rejected at manifest parse and at the
  gateway deploy route
  (`preview.env.<KEY> conflicts with db.roles single (remove the remap
  or use db.roles dual)`), naming both sides. The remap is the adopter
  literally saying "I use this credential", so the two must never
  disagree silently. `db.roles` on `sqlite` / `none` is rejected like an
  out-of-scope env key
  (`db.roles requires db.provider postgres`).
- The role lifecycle follows the resolved mode: `createDatabase`
  provisions the companion only in `dual`, taking the mode as an
  explicit options argument (per-repo manifest state resolved at deploy
  time, never module state). Teardown keeps calling `DROP ROLE IF
  EXISTS` unconditionally so a preview created while dual still cleans
  up after the repo flips to single.
- Env injection follows the resolved mode in `pgConnectionEnv`; the
  `withGatewayConnectionEnv` reservation set is unchanged (every
  `PREVIEW_ENV_KEYS` name stays stripped from adopter env in both
  modes).
- The name budget follows the mode at the deploy boundary only:
  `validatePreviewIdentity` allows db names up to `PG_IDENT_MAX` in
  `single` and stays at `PG_IDENT_MAX - len("_app")` in `dual`. The
  catalog read path (`isPreviewDbName` / `parsePreviewDatabaseName`,
  which list/teardown/sweep run over historical rows) stays permissive
  at `PG_IDENT_MAX` so flipping a repo never makes an existing preview
  unlistable or unremovable.

## Consequences

- Adopters who never mention the companion get none: no role
  create/sync per deploy, no `PGAPP*` names in container env, no
  per-migration `GRANT` obligation, and four more characters of db-name
  budget. Adopters who remap a companion key keep working with zero
  config change (derived `dual`).
- No `dual`/`legacy` alias for the injected names; no change to the
  `mail.*` grammar, hostname templates, or `preview.env` keys beyond
  the new guard. Automatically `GRANT`ing table privileges /
  `ALTER DEFAULT PRIVILEGES` stays a separate change.
- Amends ADR-0007: the companion `PGAPPUSER` / `PGAPPPASSWORD` keys are
  canonical only for `dual` previews (see the amendment note there).

## Amendment 2026-09-24: see ADR-0007 amendment

ADR-0007 carries the one-line amendment pointing at this decision; this
file stays the record of the roles axis itself.
