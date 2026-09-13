# Public docs site

Single-page static docs for sprout (no separate hosting).

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

Checks local links in `docs/site/index.html` and `README.md`.
