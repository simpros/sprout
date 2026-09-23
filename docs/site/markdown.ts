// Markdown rendering for the published docs site.
//
// TanStack Markdown is the parser: markdown stays canonical, is parsed once
// into an AST, and rendered from there — heading ids, the "On this page"
// TOC, and the code block component all read the same tree instead of
// regexing rendered HTML. Heading ids follow GitHub's anchor rule (the
// dialect every in-corpus `#fragment` already assumes), with GitHub-style
// dedupe (`head`, `head-1`, …).
import { parseMarkdown } from "@tanstack/markdown";
import type {
  MarkdownDocument,
  MarkdownExtension,
} from "@tanstack/markdown";
import { renderHtml } from "@tanstack/markdown/html";
import { headingCollectionExtension } from "@tanstack/markdown/extensions/headings";
import { dirname, relative, resolve } from "node:path/posix";
import {
  codeBlockExtension,
  escapeHtml,
} from "./codeblock.ts";
import {
  renderShell,
  PROMPT_MARKER,
  type ShellNavItem,
  type ShellTocEntry,
} from "./shell.ts";

export { escapeHtml };

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

// Per-document slugger closing over its own repeat table, so the `.md`
// fragment namespace and the `.html` id namespace are literally one.
function githubHeadingIdsFn(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    let slug = slugHeading(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    return slug;
  };
}

// Stateless across documents: the heading collector only derives
// `document.headings`, and the code block component only renders `code` nodes.
const markdownExtensions: MarkdownExtension[] = [
  headingCollectionExtension(),
  codeBlockExtension,
];

export function parseMarkdownDocument(markdown: string): MarkdownDocument {
  return parseMarkdown(markdown, {
    allowHtml: true,
    headingIds: githubHeadingIdsFn(),
    extensions: markdownExtensions,
  });
}

function renderDocumentBody(document: MarkdownDocument): string {
  return renderHtml(document, {
    allowHtml: true,
    headingAnchors: true,
    extensions: markdownExtensions,
  });
}

export function documentToc(document: MarkdownDocument): ShellTocEntry[] {
  return (document.headings ?? []).map((heading) => ({
    id: heading.id,
    text: heading.text,
    level: heading.level,
  }));
}

export function markdownToHtmlBody(markdown: string): string {
  return renderDocumentBody(parseMarkdownDocument(markdown));
}

// The single copy-paste block lives in `docs/onboarding-prompt.md` as one
// ```text fence; every other surface embeds this extracted text.
export function extractPromptText(markdown: string): string {
  const match = /```text\n([\s\S]*?)\n```/.exec(markdown);
  if (!match) {
    throw new Error("onboarding prompt source carries no ```text block");
  }
  return match[1]!.trim();
}

// Published `.md` stays a complete, self-contained prompt for agents.
export function promptFence(prompt: string): string {
  return ["```text", prompt, "```"].join("\n");
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
// through untouched. Regex over rendered HTML on purpose: the AST link nodes
// carry bare hrefs without the twin mapping, which only assembly knows.
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

export type MarkdownPageOptions = {
  description?: string;
  nav?: ShellNavItem[];
  // Substituted after rendering: the figure carries blank lines, which
  // cannot survive a trip through the markdown parser as an HTML block.
  promptFigure?: string;
};

export function renderMarkdownPage(
  title: string,
  markdown: string,
  sourceFile: string,
  renderedHtmlPages: Set<string>,
  opts: MarkdownPageOptions = {},
): string {
  const document = parseMarkdownDocument(markdown);
  const rendered = rewritePageLinks(
    renderDocumentBody(document),
    sourceFile,
    renderedHtmlPages,
  );
  const body =
    opts.promptFigure === undefined
      ? rendered
      : rendered.split(PROMPT_MARKER).join(opts.promptFigure);
  return renderShell({
    title,
    description: opts.description ?? title,
    homeHref: "site/index.html",
    toRoot: "..",
    toDocs: ".",
    nav: opts.nav ?? [],
    toc: documentToc(document),
    bodyHtml: body,
  });
}

export function pageTitle(markdown: string, fallback: string): string {
  const match = /^#\s+(.*)$/m.exec(markdown);
  return match ? match[1]!.trim() : fallback;
}
