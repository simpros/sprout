# Public docs site

Single-page static docs for sprout.

**Live:** https://simpros.github.io/sprout/

## Preview

```bash
bun run docs:preview
# → http://127.0.0.1:4173/docs/site/index.html
```

Serves the repo root so the page keeps its real URL path (`/docs/site/index.html`;
`/` redirects there) and relative links resolve with ordinary static-file
semantics. Override port with `DOCS_PORT=8080 bun run docs:preview`.

## Link check

Included in `bun run build` and `bun run typecheck`, or alone:

```bash
bun run docs:check
```

`docs:check` assembles the publish set (single manifest in
`docs/site/assemble.ts`) into a temp dir and checks every published
HTML/markdown page there with static-host semantics — a target must be a
file (or a directory carrying its own `index.html`; Pages never serves
generated listings). Green `docs:check` therefore means the Pages URLs
resolve, including `docs/adoption.md` and the ADRs.

## GitHub Pages

`.github/workflows/docs.yml` runs `docs:check`, then `docs:assemble` into
`_site` (repo-relative paths preserved, so relative hrefs resolve exactly
like local preview) and uploads it, on pushes to `main` touching the docs
corpus or via `workflow_dispatch`. Path filters are intentionally broader
than the publish set so linked fragments cannot go stale.

Repo setting: **Settings → Pages → Source = GitHub Actions**.
