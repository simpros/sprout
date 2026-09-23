# Public docs site

Multi-page agent-first docs for sprout.

**Live:** https://simpros.github.io/sprout/

## Pages

Markdown is canonical under `docs/`: `getting-started`, `adopting-a-repo`,
`ci-integration`, `operator-deploy`, `previews`, `cli-reference`,
`troubleshooting`, `onboarding-prompt`, plus `herdr-integration`.
`docs/index.html` lists every page; `llms.txt` at the site root
is the machine-readable index (onboarding prompt = entry point).

## Render

`docs/site/assemble.ts` renders each page markdown → HTML at assemble time
via `docs/site/markdown.ts` (TanStack Markdown `@tanstack/markdown`,
exactly pinned in root `devDependencies` — a docs-toolchain dependency;
published pages stay dependency-free). Markdown stays canonical: each page
is parsed once into an AST (`parseMarkdown` with the GitHub anchor dialect
as `headingIds`, plus GitHub-style dedupe) and rendered from that tree
(`renderHtml` from `@tanstack/markdown/html`; no `/react` import anywhere),
so the `.md` fragment namespace and the `.html` id namespace are one, and
the "On this page" TOC and the code block component read the same tree
instead of regexing HTML. Intra-page `.md` links rewrite to their `.html`
twins (fragments preserved); links to files with no HTML twin (examples,
templates, env samples) stay `.md`. Targeted tests (`markdown.test.ts`)
hold the shipped behavior: GitHub-slug heading ids with GitHub-style
dedupe, the AST-based prompt extraction (meta-tagged fence, loud on inner
fences), and the pinned toolchain (no `/react` import anywhere).

One design: `docs/site/theme.css` is the single stylesheet (extracted from
the marketing page) and `docs/site/shell.ts` the single chrome (header with
brand + docs nav, `<main>`, footer) — the marketing page, the docs index,
and every docs page inline the same theme text and the same copy script, so
the surfaces cannot drift. `docs/site/marketing.html` is the source of the
marketing page but is a body fragment, never copied verbatim: it carries
`<!-- docs-onboarding-prompt -->` in the adopt section, resolved at
assembly into the published `docs/site/index.html` artifact, while its title
and description live in the `marketingPage`
manifest next to `docsPages`. Docs pages get a docs nav
built from `docsPages` (a new page appears automatically) and an "On this
page" TOC from the parsed headings. The theme and the client script stay
inlined — no external CSS/JS fetch, no new published file.

Every fenced block renders as the code block component
(`docs/site/codeblock.ts`: `figure.codeblock` + language label + copy
button + `pre > code`); the marketing page's one static snippet is the
same markup written by hand, and the embedded prompt figure comes from the
single `promptFigure` builder — no bare `<pre>` survives assembly. The single inlined
script copies the sibling block's text, flips the label transiently, and
announces through a polite live region, degrading to text selection without
a clipboard API.

The onboarding prompt lives in one place — the meta-tagged fenced block in
`docs/onboarding-prompt.md`, extracted from the AST (never a fence regex). `docs/getting-started.md` and the marketing
page carry `<!-- docs-onboarding-prompt -->`, resolved per output: `.html`
gets the component (with copy button), published `.md` gets the fenced
block verbatim, so agents fetching markdown get a complete prompt and the
assembled tree never holds an unresolved marker.

Every new page joins `docsPages` there — the publish list, the rendered
HTML, `docs/index.html`, and `llms.txt` are all generated from that one
manifest, and tests assert the checked-in `llms.txt` matches the generator
byte for byte (`docs/index.html` lives only in the assembled artifact).

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
`docsPages` + `publishDirs` in `docs/site/assemble.ts`) into a temp dir
and checks every HTML/markdown/text page found there with static-host semantics
— a target must be a file (or a directory carrying its own `index.html`;
Pages never serves generated listings), and every `#fragment` must resolve
to a GitHub-slug heading `id` in its target (the renderer emits the same
slugs, so the two share one namespace). The check runs over the assembled
tree, so URLs inside the embedded onboarding prompt are gated on the pages
that carry it. Absolute `llms.txt` links and bare
same-site URLs (the onboarding prompt lists them as plain text) resolve
against the checked tree via the shared `SITE_ORIGIN`. Check roots are discovered by
walking the artifact, so a newly published page is always gated. Green
`docs:check` therefore means the Pages URLs resolve.
`bun run docs/site/check.ts <dir>` checks
an already-assembled tree in place.

Static types for this toolchain (`docs/site/*.ts` sits outside the
workspace builds) are checked with `bun run docs:typecheck`
(`tsc --noEmit -p docs/site/tsconfig.json`, also in `bun run typecheck`
and the docs workflow), so unused imports and type errors fail CI, not
just the tests that happen to execute them.

## ADRs never ship

ADRs are maintainer internals, not consumer docs: `docs/adr` stays out of
the publish manifest, and no published page may link to or mention ADRs.
`docs/site/check.ts` enforces this structurally via `assertNoAdrLeaks`
(policy in `docs/site/adr-policy.ts`): any file under an `adr` path segment
(any extension, not just HTML/markdown pages), any standalone `ADR`/`ADRs`
word in a published page, or any artifact-relative href pointing at an
`adr` path in the assembled tree fails the docs build.

## GitHub Pages

`.github/workflows/docs.yml` runs `docs:assemble` into
`_site` (repo-relative paths preserved, so relative hrefs resolve exactly
like local preview), then gates that artifact with
`bun run docs/site/check.ts _site` before uploading it, on pushes to `main`
touching the docs corpus or via `workflow_dispatch`. Path filters are
intentionally broader than the publish set so linked fragments cannot go
stale.

Repo setting: **Settings → Pages → Source = GitHub Actions**.
