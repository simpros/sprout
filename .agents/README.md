# Agent tooling

Vendored skills live in `.agents/skills/`; invoke as each skill's frontmatter allows:

- `code-review` — review since a fixed point, Standards + Spec axes.
- `documentation-writer` — every docs/prose task.
- `emil-design-eng` — building or reviewing UI.
- `visual-pr` — PR bodies (policy in `AGENTS.md`).

User-invoked only (frontmatter disables model invocation); do not self-invoke:

- `to-spec`, `to-tickets`, `triage`, `wayfinder` — tracker-backed workflow (see `docs/agents/issue-tracker.md`).
- `review-animations` — reviewing motion code; defaults to flagging.

Everything else in `.agents/skills/` is generic; invoke from its own description (or explicitly, where its frontmatter disables model invocation).

A skill's `/setup-matt-pocock-skills` fallback means `docs/agents/issue-tracker.md`.
