# Adopter-configurable injection env names (`preview.env`)

**Status:** accepted, implemented.

Adopters remap the five canonical connection env names the gateway injects
into preview app and seed containers via optional `preview.env` in
`.sprout.yaml` (keys `PGHOST`…`PGDATABASE` → adopter names). Unmapped keys
still inject as `PG*`. Remapping replaces the name (no dual alias). Values
still come from the gateway's single preview login.

A second restricted DB role is out of scope. Product durable identity rename is
a separate decision (ADR-0006).
