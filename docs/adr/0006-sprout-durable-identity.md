# Durable runtime identity is `sprout*`

Compose project, networks, SQLite path, Postgres roles, container names
(`sprout-<slug>-pr-<id>`) and preview databases (`sprout_<slug>_pr<id>`) all
carry the product name, replacing the legacy `preview-buddy` / `pb` / `prev_`
prefixes. These names are persisted in operator state, so renaming again means
wiping volumes, networks and state; there is no migrator.
