# Agent tooling

Vendored skills live in `.agents/skills/`; invoke by trigger:

- `code-review`, `to-spec`, `to-tickets`, `triage`, `wayfinder` — tracker-backed workflow (see `docs/agents/issue-tracker.md`).
- `documentation-writer` — every docs/prose task.
- `emil-design-eng` — building or reviewing UI.
- `review-animations` — reviewing motion code; defaults to flagging.
- `visual-pr` — PR bodies (policy in `AGENTS.md`).

Everything else in `.agents/skills/` is generic; invoke from its own description (or explicitly, where its frontmatter disables model invocation).
