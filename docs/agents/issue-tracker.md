# Issue tracker: GitHub

Issues for this repo live as GitHub issues on `simpros/sprout`. Use `gh` for all operations.

PRs as a request surface: no. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

Operations: `gh issue view|comment|close|edit`; tickets = `gh issue create`.

## Wayfinding operations

- Parent map = one open issue titled `Map: <destination>`.
- The skill's `wayfinder:map` and `wayfinder:<type>` labels do not exist in this repo — omit `--label`, name the ticket type in the body instead.
- Child = issue with `Part of #<map>` in the body.
- Blocking = `Blocked by: #<n>` line in the body (not a comment).
- Frontier = open unassigned child with no open issue in its `Blocked by` line.
- Claim = assign to yourself first.
- Resolve = comment the answer, close, append a pointer to the map's Decisions-so-far.
