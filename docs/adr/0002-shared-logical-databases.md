# Shared instance with logical per-PR databases

Each preview gets its own **logical database** (`prev_<slug>_pr<id>`) on one
shared Postgres instance. sprout does not spawn Postgres containers per
PR in v0.1.

Per-PR Postgres containers were rejected for v0.1: correct isolation but
~50–100 MB RAM per open PR and gateway-owned container lifecycle. Schema-per-PR
on one database was rejected: leaks into application code and complicates
cleanup. Hosted branching (Neon-style) contradicts the self-hosted premise.

Total database overhead stays ~one Postgres regardless of PR count. A
multi-container-per-preview backend may follow behind the same preview-db
interface when hard isolation is required.
