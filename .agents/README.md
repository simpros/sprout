# Agent tooling

Vendored skills live in `.agents/skills/`; invoke by trigger:

- `code-review`, `to-spec`, `to-tickets`, `triage`, `wayfinder` — tracker-backed workflow (redirect below).
- `documentation-writer` — every docs/prose task.
- `emil-design-eng` — building or reviewing UI.
- `review-animations` — reviewing motion code; defaults to flagging.
- `visual-pr` — PR bodies (policy in `AGENTS.md`).

Tracker redirect: any vendored reference to `docs/agents/*` or
`/setup-matt-pocock-skills` resolves to GitHub issues/PRs on
`simpros/sprout` via `gh`; labels: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`.
PRs as a request surface: no. Tickets: `gh issue create`, parent map =
issue labelled `wayfinder:map`, child = sub-issue with `Part of #<map>`,
blocking = `Blocked by: #<n>` (or native dependencies), frontier = open
unassigned unblocked children. Read/fetch/comment/close via
`gh issue view|comment|close`.
