# Product `sprout*` durable runtime identity

**Status:** accepted, not yet implemented.

Durable runtime identity **will** use the product name `sprout` — compose
project, networks, SQLite path, Postgres roles, preview container names
`sprout-<slug>-pr-<id>`, preview databases `sprout_<slug>_pr<id>` — replacing
the legacy opaque `preview-buddy` / `pb` / `prev_` prefixes kept after the
package rename. Operators upgrading from those defaults wipe
volumes/networks/state and redeploy; there is no migrator (v0.1 pre-release).

Until this ships, runtime and operator defaults remain `preview-buddy` / `pb` /
`prev_` (see ADR-0002 and `docker-compose.yml`). Do not rewrite CONTEXT,
adoption, deploy, or example env files to `sprout*` until the code and compose
defaults match.

Adopter-configurable injection names are a separate decision (ADR-0007).
