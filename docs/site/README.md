# Public docs site

Single-page static docs for sprout (no separate hosting).

## Preview

```bash
bun run docs:preview
# → http://127.0.0.1:4173
```

Override port with `DOCS_PORT=8080 bun run docs:preview`.

## Build

Included in `bun run build`, or alone:

```bash
bun run docs:build
```

Output: `docs/site/dist/index.html` (link-checked copy of `index.html`).
