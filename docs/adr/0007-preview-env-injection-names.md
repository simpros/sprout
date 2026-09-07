# Adopter-configurable injection env names (`preview.env`)

**Status:** accepted, not yet implemented.

Adopters **will** remap the five canonical connection env names the gateway
injects into preview app and seed containers via optional `preview.env` in
`.sprout.yaml` (keys `PGHOST`…`PGDATABASE` → adopter names). Unmapped keys
still inject as `PG*`. Remapping replaces the name (no dual alias). Values
still come from the gateway's single preview login.

Until this ships, `.sprout.yaml` rejects unknown keys including `preview.env`,
and the gateway always injects `PGHOST`…`PGDATABASE`. Do not document the remap
contract in CONTEXT or the adoption guide until yaml parse, deploy body, and
`pgConnectionEnv` implement it.

A second restricted DB role is out of scope. Product durable identity rename is
a separate decision (ADR-0006).
