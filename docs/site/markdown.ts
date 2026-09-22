// Markdown rendering for the published docs site.
//
// The runtime's built-in GFM renderer is the canonical parser: it handles
// lazy list continuations, nested lists, and emphasis. Nothing hand-rolled
// lives here on purpose.
import { dirname, relative, resolve } from "node:path/posix";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function markdownToHtmlBody(markdown: string): string {
  return Bun.markdown.html(markdown, { headings: true });
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

// Rewrite intra-corpus `.md` links to their rendered `.html` twins (fragments
// preserved) so the human artifact never drops readers into raw source.
// Links to files with no HTML twin (examples, templates, env samples) pass
// through untouched.
export function rewritePageLinks(
  html: string,
  sourceFile: string,
  renderedHtmlPages: Set<string>,
): string {
  const dir = dirname(sourceFile);
  return html.replace(/href="([^"]+)"/g, (whole, href: string) => {
    if (
      href.startsWith("http://") ||
      href.startsWith("https://") ||
      href.startsWith("mailto:") ||
      href.startsWith("//") ||
      href.startsWith("#")
    ) {
      return whole;
    }
    const hash = href.indexOf("?");
    const cut = href.indexOf("#");
    const end = Math.min(
      hash === -1 ? href.length : hash,
      cut === -1 ? href.length : cut,
    );
    const pathPart = href.slice(0, end);
    if (!pathPart.endsWith(".md")) return whole;
    const rel = relative(
      "/",
      resolve("/", dir, pathPart).replace(/\.md$/, ".html"),
    );
    if (!renderedHtmlPages.has(rel)) return whole;
    return `href="${pathPart.slice(0, -3)}.html${href.slice(end)}"`;
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
