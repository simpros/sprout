# Adopter-configurable injection env names (`preview.env`)

**Status:** accepted, implemented.

Adopters remap the canonical connection env names the gateway injects
into preview app and seed containers via optional `preview.env` in
`.sprout.yaml` (keys `PGHOST`…`PGDATABASE`, plus companion
`PGAPPUSER` / `PGAPPPASSWORD` → adopter names). Unmapped keys still
inject under their canonical names. Remapping replaces the name (no dual
alias).

Owner values (`PGUSER` / `PGPASSWORD`) come from the gateway's static
preview login. Companion values are a per-preview-DB restricted LOGIN
(`<dbName>_app`) with a password derived from the owner preview password
— dual-role / RLS apps use the companion for runtime queries and the
owner for migrations. Product durable identity rename is a separate
decision (ADR-0006).
