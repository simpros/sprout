# Architecture decision records

Record a decision here only when it is hard to reverse *and* hard to
understand — everything else lives in `CONTEXT.md`, code docstrings, or the
normative spec issue. ADR numbers are immutable: never reuse a number.

| ADR | Decision |
|---|---|
| [0001](0001-one-process-two-modules.md) | One Docker image, one process, preview-db + app-deployment modules |
| [0002](0002-shared-logical-databases.md) | Shared Postgres instance, logical per-PR databases |
| [0003](0003-seed-as-user-image.md) | Seeding via user-built one-shot seed image, no gateway clone |
| [0004](0004-ci-driven-lifecycle-no-webhooks.md) | Symmetric CI lifecycle; no forge webhooks in v0.1 |
| [0005](0005-self-made-bearer-tokens.md) | Self-made bearer tokens in SQLite, not better-auth |
| [0006](0006-sprout-durable-identity.md) | `sprout*` durable identity |
| 0007 | Retired → `docs/adopting-a-repo.md` (`preview.env` remap grammar) |
| [0008](0008-preview-db-providers.md) | Preview database providers: Postgres, SQLite, none (folds 0009) |
| 0009 | Retired → ADR-0008 |
| 0010 | Retired → `docs/previews.md` (Preview labels: reserved set derived from the gateway's label emission) |
| 0011 | Retired → `docs/onboarding-prompt.md` (page set lives in `docs/site/assemble.ts` `publishFiles`) |
| 0012 | Retired → ADR-0008 (`db.roles` invariant) and `docs/adopting-a-repo.md` (`db.roles` contract) |
| [0013](0013-preview-access-gate.md) | Preview access gate: per-preview `none` default \| `basic` \| `link`, gateway-native |
