# Agent tooling

Vendored skills live in `.agents/skills/`; invoke by trigger:

- `code-review`, `to-spec`, `to-tickets`, `triage`, `wayfinder` — tracker-backed workflow (redirect below).
- `documentation-writer` — every docs/prose task.
- `emil-design-eng` — building or reviewing UI.
- `review-animations` — reviewing motion code; defaults to flagging.
- `visual-pr` — PR bodies (policy in `AGENTS.md`).

### Tracker

Tracker: the one `AGENTS.md` names. Any vendored reference to
`docs/agents/*` or `/setup-matt-pocock-skills` resolves to it.
Operations: `gh issue view|comment|close|edit`; tickets =
`gh issue create`. PRs as a request surface: no.

### Wayfinding operations

Parent map = one open issue titled `Map: <destination>`; child =
native sub-issue (`Part of #<map>` in the body only where sub-issues
are unavailable); blocking = `Blocked by: #<n>` (or native
dependencies); frontier = open unassigned unblocked children.
