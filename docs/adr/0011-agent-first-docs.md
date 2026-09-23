# Agent-first multi-page docs + onboarding prompt

**Status:** accepted, implemented.

## Context

Two long guides carried the whole contract. Agents are the primary consumer
now and there was nothing agent-shaped: no per-topic pages, no index, no
machine-readable catalogue, no paste-into-a-harness prompt.

## Decision

- Markdown stays canonical under `docs/`: one topic per page with a stable
  URL (`getting-started`, `adopting-a-repo`, `ci-integration`,
  `operator-deploy`, `previews`, `cli-reference`, `troubleshooting`,
  `onboarding-prompt`; `herdr-integration` joins the same section).
- `docs/site/assemble.ts` renders each page markdown to HTML at assemble
  time; both `.md` (agents) and `.html` (humans) ship from one source, and
  the link gate runs over the whole artifact.
- `docs/index.html` lists every page with its one-line description.
  `llms.txt` at the site root lists every page with its canonical URL and
  marks the onboarding prompt as the entry point.
- `docs/adoption.md` and `docs/deploy.md` stay as thin landing pages: same
  old headings so old fragments still land, each heading linking out to the
  page that now owns it.
- `docs/onboarding-prompt.md` is one copy-paste block: fetch index then
  config then CI docs, inspect the repo, confirm slug and hostname template
  with the user, write only `.sprout.yaml` / optional `Dockerfile.seed` /
  the CI file, name the masked variables the user sets, verify with the CLI
  loader, next step `sprout doctor` / first `sprout ci preview`.

## Consequences

- New pages join `publishFiles` in `docs/site/assemble.ts`; the assemble
  and check suites assert the page set and the render step.
- Inbound references point at the new pages; old paths never 404.
- Published pages never carry maintainer internals; the gate enforces it on
  markdown sources and rendered HTML alike.

## Amendment 2026-09-23: legacy moved-content pages removed

The thin landing pages (`adoption.md` and `deploy.md`) are deleted
along with the `legacy` manifest branch and the "Legacy entry points"
index paragraph. There is no redirect shim: `docs/deploy.html` and
`docs/adoption.html` now 404, and all inbound references point at
`docs/operator-deploy.md` / `docs/adopting-a-repo.md`.
