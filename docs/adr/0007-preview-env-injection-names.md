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

Mail follows the same grammar: canonical `MAILHOST`…`MAILREPLYTO` keys are
injected into app, companion service and seed containers and remappable
through `preview.env` with the same replace-not-alias rule. `MAILFROM` /
`MAILREPLYTO` carry the per-preview send-from identity
(`<slug>-pr<pr_id>@<SPROUT_MAIL_FROM_DOMAIN>`), `MAILFROMNAME` its display
label; a `mail.from` `{pr_id}` template overrides the address.

## Amendment 2026-09-24: companion keys are dual-only (ADR-0012)

The companion `PGAPPUSER` / `PGAPPPASSWORD` keys above are canonical
only for `dual` previews. Since ADR-0012 the restricted companion role
is opt-in via `db.roles` (`single` | `dual`, Postgres only; default
`dual` when `preview.env` remaps a companion key, else `single`):
`single` previews inject no `PGAPP*` names anywhere, and an explicit
`db.roles: single` plus a companion remap fails fast at manifest parse
and at the deploy route.
