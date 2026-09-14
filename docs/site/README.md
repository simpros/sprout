# Public docs site

Single-page static docs for sprout.

**Live:** https://simpros.github.io/sprout/

## Preview

```bash
bun run docs:preview
# → http://127.0.0.1:4173/docs/site/index.html
```

Serves the assembled Pages tree (same `_site` layout CI uploads) so the
page keeps its real URL path (`/docs/site/index.html`; `/` redirects
there) and relative links resolve with ordinary static-file semantics
against exactly what Pages will serve. Override port with
`DOCS_PORT=8080 bun run docs:preview`.

## Link check

Included in `bun run build` and `bun run typecheck`, or alone:

```bash
bun run docs:check
```

`docs:check` assembles the publish set (single manifest —
`publishFiles` + `publishDirs` in `docs/site/assemble.ts`) into a temp dir
and checks every HTML/markdown page found there with static-host semantics
— a target must be a file (or a directory carrying its own `index.html`;
Pages never serves generated listings). Check roots are discovered by
walking the artifact, so a newly published page is always gated. Green
`docs:check` therefore means the Pages URLs resolve, including
`docs/adoption.md`. `bun run docs/site/check.ts <dir>` checks
an already-assembled tree in place.

## ADRs never ship

ADRs are maintainer internals, not consumer docs: `docs/adr` stays out of
the publish manifest, and no published page may link to or mention ADRs.
`docs/site/check.ts` enforces this structurally — any ADR file
(`docs/adr/...`) or ADR mention (`ADR`, `ADRs`, `adr/...` in any case)
in the assembled tree fails the docs build.

## GitHub Pages

`.github/workflows/docs.yml` runs `docs:assemble` into
`_site` (repo-relative paths preserved, so relative hrefs resolve exactly
like local preview), then gates that artifact with
`bun run docs/site/check.ts _site` before uploading it, on pushes to `main`
touching the docs corpus or via `workflow_dispatch`. Path filters are
intentionally broader than the publish set so linked fragments cannot go
stale.

Repo setting: **Settings → Pages → Source = GitHub Actions**.
