# AGENTS.md

## Stack

- **Runtime:** Bun
- **Monorepo:** Turborepo workspaces (`apps/*`, `packages/*`)
- **Language:** TypeScript (strict, ESM)
- **HTTP:** Elysia (`apps/server`)
- **CLI:** `sprout` (`apps/cli`)
- **API client:** `@sprout/api-client` (Elysia Eden)
- **Control-plane DB:** SQLite via Drizzle ORM (`drizzle-orm` RC) + `drizzle-kit` migrations
- **Preview Postgres:** `Bun.sql` admin connection for CREATE/DROP DATABASE
- **Tests:** `bun test`

## Commands

```bash
bun install
bun run dev          # turbo dev, server watch only
bun run sprout …     # CLI against SPROUT_URL (default http://127.0.0.1:7331)
bun test
bun run test:e2e     # compose acceptance harness (needs Docker)
bun run typecheck    # turbo build (tsc per package)
bun run db:generate  # drizzle-kit generate (apps/server)
bun run db:migrate   # runtime migrator (apps/server; same as boot)
```

## Layout

- `apps/server` — gateway process, Drizzle schema/migrations, Elysia HTTP app
- `apps/cli` — `sprout` CLI (uses api-client)
- `packages/api-client` — typed Eden client against `@sprout/server/api-type`
- `packages/preview-db` — shared Postgres catalog DDL (ensure-role, worktree provision/drop)
- `packages/preview-env` — canonical PG* env names + adopter remap (ADR-0007)

## Style

- Plain functions, no classes.
- Keep modules small and focused.
- Fail fast at config load for required env vars.
- DB schema lives in `apps/server/src/infrastructure/db/`; migrations in `apps/server/drizzle/`.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues on `simpros/sprout`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
