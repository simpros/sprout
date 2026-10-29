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
- `packages/preview-env` — preview wire grammar: PG* env remap, hostname templates, health request-shape

## Conventions

- Code and comment style: `CODE-STYLE.md`.
- Domain vocabulary: `CONTEXT.md`. Decisions: `docs/adr/` (only hard-to-reverse, hard-to-understand ones).
- Issues: GitHub issues on `simpros/sprout` via `gh`; tracker spec and triage labels: `docs/agents/issue-tracker.md`.
- PRs: always describe with the `visual-pr` skill (`.agents/skills/visual-pr/`), even though it is explicit-invoke by default. `show-me` goes in a comment, never the body.
- Agent tooling (vendored skill index): `.agents/README.md`. Issue tracker operations: `docs/agents/issue-tracker.md`.
