# Code style

- Plain functions, no classes.
- Periodic work uses `Bun.cron`, never `setTimeout`/`setInterval`.
- Keep modules small and focused.
- Fail fast at the boundary that owns the value: boot for gateway-scope config, the deploy route for per-repo provider config (a sqlite-only gateway boots with no Postgres env).
- DB schema lives in `apps/server/src/infrastructure/db/`; migrations in `apps/server/drizzle/`.

## Comments

State the why only, and only when the code cannot say it.

- No restating code, signatures or types.
- No tickets, PRs, review feedback or people. No history ("previously", "now uses").
- No ADR numbers in comments or test names; if the deviation matters, name the deviation.
- No commented-out code. No "hack" / "for now" / emoji.
- Keep real whys: invariants, ordering/locking, observed external behaviour,
  security tradeoffs, magic constants.
- Inline comments: one line. Module/function docstrings: one invariant, no headings or bullet lists. Longer reasoning is a decision: put it in `CONTEXT.md` or an ADR.
- A comment that contradicts the code is a bug; fix one of them.
