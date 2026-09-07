# sprout identity and configurable injection env names

Durable runtime identity uses the product name `sprout` (compose project,
networks, SQLite path, Postgres roles, preview container names
`sprout-<slug>-pr-<id>`, preview databases `sprout_<slug>_pr<id>`) — not the
legacy opaque `preview-buddy` / `pb` / `prev_` prefixes kept after the package
rename. Operators upgrading from those defaults wipe volumes/networks/state
and redeploy; there is no migrator (v0.1 pre-release).

Separately, adopters may remap the five canonical connection env names the
gateway injects into preview app and seed containers via optional
`preview.env` in `.sprout.yaml` (keys `PGHOST`…`PGDATABASE` → adopter names).
Unmapped keys still inject as `PG*`. Remapping replaces the name (no dual
alias). Values still come from the gateway's single preview login; a second
restricted DB role is out of scope.
