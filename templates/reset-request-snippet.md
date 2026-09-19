<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Reset request checkbox

Tick a box in the MR/PR description and the next `sprout ci preview` run
wipes the preview database and redeploys from scratch — no webhook, no extra
token, no adopter script. Paste this snippet into the MR/PR description:

```markdown
- [ ] Sprout: reset preview <!-- sprout-reset: ada-2026-09-19-1 -->
```

To request a reset: tick the box (`- [x]`) **and** change the token after the
colon to something new (date + initials + counter works). The token change is
what makes the request fire exactly once — re-runs and pipeline retries see
the stored token and deploy normally.

Rules:

- Both parts are required: a ticked box with no marker (or a marker with an
  unticked box) does nothing.
- Ticks and markers inside fenced code blocks are ignored.
- GitHub: after the reset, the job unticks the box and keeps the marker, so
  the `edited` event that rewrite triggers is a no-op.
- GitLab: keep the snippet inside the first 2700 characters of the
  description. GitLab exposes only that prefix to CI
  (`CI_MERGE_REQUEST_DESCRIPTION`); when it is truncated the preview job
  fails with a named error instead of silently ignoring the tick.
- `sprout ci reset` consumes a pending request too: a hand-run reset marks
  the current token handled so the next push does not wipe again.
