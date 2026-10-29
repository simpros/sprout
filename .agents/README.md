# Agent tooling

Vendored skills live in `.agents/skills/`; invoke by trigger:

- `code-review`, `to-spec`, `to-tickets`, `triage`, `wayfinder` — tracker-backed workflow (redirect below).
- `documentation-writer` — every docs/prose task.
- `emil-design-eng` — building or reviewing UI.
- `review-animations` — reviewing motion code; defaults to flagging.
- `visual-pr` — every PR body; `show-me` goes in a comment, never the body.

Tracker redirect: any vendored reference to `docs/agents/*` or
`/setup-matt-pocock-skills` resolves to GitHub issues/PRs on
`simpros/sprout` via `gh`; labels: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`.
