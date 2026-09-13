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

Checks local links in `docs/site/index.html`, `README.md`, and `docs/deploy.md`.

## GitHub Pages

`.github/workflows/docs.yml` publishes `docs/site/` (plus linked markdown
targets so relative hrefs keep working) on pushes to `main` that touch those
paths, or via `workflow_dispatch`.

Repo setting: **Settings → Pages → Source = GitHub Actions**.
