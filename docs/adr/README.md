# Architecture decision records

Record a decision here only when it is hard to reverse *and* hard to
understand — everything else lives in `CONTEXT.md`, code docstrings, or the
normative spec issue.

| ADR | Decision |
|---|---|
| [0001](0001-one-process-two-modules.md) | One Docker image, one process, preview-db + app-deployment modules |
| [0002](0002-shared-logical-databases.md) | Shared Postgres instance, logical per-PR databases |
| [0003](0003-seed-as-user-image.md) | Seeding via user-built one-shot seed image, no gateway clone |
| [0004](0004-ci-driven-lifecycle-no-webhooks.md) | Symmetric CI lifecycle; no forge webhooks in v0.1 |
| [0005](0005-self-made-bearer-tokens.md) | Self-made bearer tokens in SQLite, not better-auth |
| [0006](0006-sprout-durable-identity.md) | `sprout*` durable identity (accepted, implemented) |
| [0007](0007-preview-env-injection-names.md) | Stub: superseded by `docs/adopting-a-repo.md` |
| [0008](0008-preview-db-providers.md) | Preview database providers: Postgres, SQLite, none (folds 0009) |
| [0009](0009-preview-db-provider-none.md) | Stub: folded into 0008 |
| [0012](0012-preview-db-roles-opt-in.md) | Stub: contract in `docs/adopting-a-repo.md`, invariants in code |
| [0013](0013-preview-access-gate.md) | Preview access gate: per-preview `basic` / `link`, gateway-native |

History: ADR numbers are immutable. 0010 (label ownership) and 0011
(agent-first docs) were dropped outright — the label-collision invariant
lives in `apps/server/src/app-deployment/label-collisions.ts`, the docs-site
rules in `docs/site/adr-policy.ts`.
