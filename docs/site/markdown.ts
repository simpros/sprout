// Markdown rendering for the published docs site.
//
// The runtime's built-in GFM renderer is the canonical parser: it handles
// lazy list continuations, nested lists, and emphasis. Nothing hand-rolled
// lives here on purpose — except heading ids, which follow GitHub's anchor
// rule (the dialect every in-corpus `#fragment` already assumes), not the
// runtime's (it collapses `→`/`/`/`—` to one hyphen where GitHub keeps two).
import { dirname, relative, resolve } from "node:path/posix";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// GitHub's anchor rule: lowercase, drop everything but letters/numbers/marks,
// `_`, `-`, and spaces, then spaces become hyphens. Punctuation between
// spaces leaves double hyphens (`A → B` → `a--b`); that is the form historic
// external anchors use, so the HTML view must emit it too.
export function slugHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
    .replace(/ /g, "-");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Retitle every heading id with the GitHub slug of its rendered text, so the
// `.md` fragment namespace and the `.html` id namespace are literally one.
// The runtime also emits a self-anchor `<a href="#id">` inside each heading;
// that href is retitled with it. Repeat headings dedupe GitHub-style
// (`head`, `head-1`, …).
function githubHeadingIds(html: string): string {
  const seen = new Map<string, number>();
  return html.replace(
    /<h([1-6]) id="([^"]*)">([\s\S]*?)<\/h\1>/g,
    (whole, level: string, oldId: string, inner: string) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ""));
      let slug = slugHeading(text);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count}`;
      return whole
        .replace(`id="${oldId}"`, `id="${slug}"`)
        .replace(`href="#${oldId}"`, `href="#${slug}"`);
    },
  );
}

export function markdownToHtmlBody(markdown: string): string {
  return githubHeadingIds(Bun.markdown.html(markdown, { headings: true }));
}

export function extractHtmlIds(html: string): string[] {
  const ids: string[] = [];
  const re = /id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}

// One split for every consumer (renderer, gate): path before `?`/`#`,
// the untouched suffix after it, and the `#fragment` without the hash.
export function splitHref(href: string): {
  path: string;
  suffix: string;
  fragment: string | null;
} {
  const query = href.indexOf("?");
  const hash = href.indexOf("#");
  const end = Math.min(
    query === -1 ? href.length : query,
    hash === -1 ? href.length : hash,
  );
  return {
    path: href.slice(0, end),
    suffix: href.slice(end),
    fragment: hash === -1 ? null : href.slice(hash + 1),
  };
}

// Protocol links leave the artifact; same-page `#anchors` do not — they
// resolve against their own file in both the renderer and the gate.
export function isExternalHref(href: string): boolean {
  return (
    href.startsWith("//") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:")
  );
}

// Rewrite intra-corpus `.md` links to their rendered `.html` twins (fragments
// preserved) so the human artifact never drops readers into raw source.
// Links to files with no HTML twin (examples, templates, env samples) pass
// through untouched. Regex over rendered HTML on purpose: the runtime's
// `render` callback API hands handlers plain text without inline markup, so
// rewriting there would have to re-render emphasis and code spans by hand.
export function rewritePageLinks(
  html: string,
  sourceFile: string,
  renderedHtmlPages: Set<string>,
): string {
  const dir = dirname(sourceFile);
  return html.replace(/href="([^"]+)"/g, (whole, href: string) => {
    if (isExternalHref(href)) return whole;
    const { path, suffix } = splitHref(href);
    if (!path.endsWith(".md")) return whole;
    const rel = relative(
      "/",
      resolve("/", dir, path).replace(/\.md$/, ".html"),
    );
    if (!renderedHtmlPages.has(rel)) return whole;
    return `href="${path.slice(0, -3)}.html${suffix}"`;
  });
}

export function renderMarkdownPage(
  title: string,
  markdown: string,
  sourceFile: string,
  renderedHtmlPages: Set<string>,
): string {
  const body = rewritePageLinks(
    markdownToHtmlBody(markdown),
    sourceFile,
    renderedHtmlPages,
  );
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    "<main>",
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function pageTitle(markdown: string, fallback: string): string {
  const match = /^#\s+(.*)$/m.exec(markdown);
  return match ? match[1]!.trim() : fallback;
}
