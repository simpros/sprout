<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Herdr review integration (operator machine)

Optional operator-side automation that reviews every merge / pull request and
fixes feedback without human relay. Adopters need nothing for it: no extra CI
job, no extra variable, no `.sprout.yaml` key. This page is for the operator
who runs it on their own machine, so reviewers know where the bot comments
come from and where to look when they don't arrive. The `~/.hermes` /
`~/.herdr-eyes` paths below live on the operator machine, not in this repo,
and may drift — the scripts themselves are the source of truth.

All four pieces are cron-driven scripts on the operator machine. Each section
below follows the same shape: **trigger → output → log location**.

## pr-review-watch — thermo-nuclear review per MR

- **Trigger:** cron tick (every few minutes). Polls open MRs/PRs in the
  watcher's repo registry, compares each head SHA against its state file.
  New MR or new push (changed head SHA) starts one review round.
- **What it does:** opens (or reuses) a herdr review worktree for the MR and
  starts a read-only reviewer agent running the thermo-nuclear code-quality
  rubric. Dependency-bump MRs get a focused compatibility review instead
  (breaking-change risk, lockfile presence, non-bump files flagged); patch
  bumps are skipped by design.
- **What it posts:**
  - Round 1: a collapsed report comment on the MR/PR (visible header with
    verdict + short SHA and a findings index; full report inside
    `<details>`). Later rounds post as threaded replies under round 1.
  - One line into the MR's Discord channel (verdict + link to the forge
    comment — never the full report).
  - On `APPROVE`: marks the MR ready (un-draft) immediately. On repos with
    auto-merge enabled, an `APPROVE`-at-head with green checks is merged
    (squash); a merge blocked on running checks is retried on later ticks,
    and a merge refusal posts one visible warning line per cause.
  - On `REQUEST CHANGES`: kicks `pr-review-fix` (below) — every round, until
    `APPROVE`. MR merged/closed: removes the review worktree and its
    workspace (shared impl worktrees are never removed — only the review
    tab closes).
- **Logs:** `~/.hermes/scripts/pr-review-watch.log` (one line per round,
  kick, merge decision, and failure with its reason); state in
  `~/.hermes/scripts/pr-review-watch-state.json` (per-MR round, SHA,
  verdict, note/discussion ids, fix-inflight guard).

## pr-review-fix — auto-fix loop

- **Trigger:** kicked detached by `pr-review-watch` after any
  `REQUEST CHANGES` verdict (guarded so one review round kicks exactly one
  fix), or run manually against a review worktree.
- **What it does:** opens a new tab in the same review worktree and starts a
  worker agent there (never in the reviewer's pane). The agent reads the
  review report file(s) in the repo root, implements the feedback, commits
  (one commit is fine), and the script pushes to the MR source branch with
  the operator identity. A diverged worktree is rebased onto the live branch
  head and pushed with `--force-with-lease`; on conflict it aborts and
  reports failure instead of pushing a broken tree. Fundamental redesigns
  also update the PR description's `## Design` section (the living record —
  comments go stale). Review report files are never committed.
- **What it posts:** exactly one short line into the MR's Discord channel
  (`feedback implemented — pushed to <branch>`, or `push FAILED`), plus the
  push itself — the changed head SHA drives the next watcher round
  (review → fix → review … until `APPROVE`). Manual runs print the summary
  (`CHANGES / COMMIT / TESTS / SHOW-ME / READY`) for the invoking session to
  deliver instead of posting. Success closes the fix tab; failure keeps it
  for inspection.
- **Logs:** `~/.hermes/scripts/pr-review-fix.log` plus one per-MR log
  `~/.hermes/scripts/pr-review-auto-fix.<repo>-<iid>.log`.

## herdr-eyes tick — agent monitor

- **Trigger:** cron tick (every 2 minutes), script-only (no agent). Diffs the
  live herdr snapshot against its state file.
- **What it does:** tracks one Discord channel per agent worktree (created on
  first sight, renamed on agent rename, re-adopted after server restarts);
  review agents never get their own channel — their verdicts land in the
  worktree channel the watcher pins. Posts status transitions (`working`,
  `needs input` with an output excerpt, `done`/`idle`), deletes channels
  whose worktree is gone, and runs the janitor (releases done disposable
  agents to free memory) plus a stale-workspace sweep. Empty tick prints
  nothing, so nothing is delivered.
- **What it posts:** short event lines into the affected channel (see
  [Discord output format](#discord-output-format-one-liners)), plus the
  tick summary (if any) to the home channel.
- **Logs:** `~/.herdr-eyes/eyes.log`; state in `~/.herdr-eyes/state.json`
  (agent → worktree, channel, status).

## sprout-chain — next-ticket kicker

- **Trigger:** cron tick (every 10 minutes), script-only. Scans the sprout
  tracker for the milestone's next unblocked ticket.
- **What it does:** kicks at most one ticket per run: the issue must be open,
  labelled `ready-for-agent`, in the milestone, with every `Blocked by`
  issue closed — and with no existing branch, worktree, live impl agent, or
  prior kick for it. A cap on concurrent impl agents plus a free-RAM floor
  keeps a chain from piling agents onto the box. Adopter work stays out of
  this path entirely (it lives in the private tracker, never as public
  sprout issues).
- **What it posts:** one line per kick on stdout (which the cron delivers);
  silence means nothing was unblocked.
- **Logs:** `~/.hermes/scripts/sprout-chain.log`; state in
  `~/.hermes/scripts/sprout-chain-state.json`.

## Discord output format (one-liners)

Full findings always live on the forge (the MR/PR comment). Discord carries
one short line per event — no technical detail, no report paste:

```text
🧊 mr-review <repo>#<iid> · round <n> · verdict <APPROVE|REQUESTCHANGES> · 🔗 <comment-url>
🔧 feedback implemented on #<iid> — pushed to `<branch>` · <pr-url>
⚠️ mr-review <repo>#<iid> · APPROVE `<sha>` not merged — <reason> · needs a human push
👀 monitoring herdr agent `<name>` · `<repo>/<worktree>` / status: <status>
```

`herdr-eyes` transitions render as `▶️ working`, `⏸ NEEDS INPUT` (with a
short output excerpt), `✅ done — ready for pickup`, and `🗑 <agent> —
worktree gone, channel deleted`.

## See also

- [CI integration](ci-integration.md) — the one-include flow this automation
  reviews (no adopter action needed for review/fix to run).
- [Operator deploy](operator-deploy.md) — the gateway stack the previews run on.
