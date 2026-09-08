# Product `sprout*` durable runtime identity

**Status:** accepted, implemented.

Durable runtime identity uses the product name `sprout` — compose project,
networks, SQLite path, Postgres roles, preview container names
`sprout-<slug>-pr-<id>`, preview databases `sprout_<slug>_pr<id>` —
replacing the legacy opaque `preview-buddy` / `pb` / `prev_` prefixes kept
after the package rename. Operators upgrading from those defaults wipe
volumes/networks/state and redeploy; there is no migrator (v0.1 pre-release).

Adopter-configurable injection names are a separate decision (ADR-0007).
