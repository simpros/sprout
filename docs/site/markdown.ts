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
  BlockNode,
  CodeBlockNode,
  MarkdownDocument,
  MarkdownExtension,
} from "@tanstack/markdown";
import { renderHtml } from "@tanstack/markdown/html";
import { headingCollectionExtension } from "@tanstack/markdown/extensions/headings";
import { dirname, relative, resolve } from "node:path/posix";
import {
  codeBlockExtension,
  isPromptFence,
  PROMPT_FENCE_META,
} from "./codeblock.ts";
import type { ShellTocEntry } from "./shell.ts";

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

function parseMarkdownDocument(markdown: string): MarkdownDocument {
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

// One parse+render pairing, owned here: every consumer parses and renders
// through this, so an extension added to one side cannot half-work.
export function renderMarkdown(markdown: string): {
  document: MarkdownDocument;
  body: string;
} {
  const document = parseMarkdownDocument(markdown);
  return { document, body: renderDocumentBody(document) };
}

export function markdownToHtmlBody(markdown: string): string {
  return renderMarkdown(markdown).body;
}

// The single copy-paste block lives in `docs/onboarding-prompt.md` as the
// ```text fence carrying the prompt meta tag; every other surface embeds this
// extracted text. Read from the AST, not a fence regex, so a second fenced
// example inside the prompt can never silently truncate the extraction.
export function extractPromptText(markdown: string): string {
  const fences: CodeBlockNode[] = [];
  const visit = (nodes: BlockNode[]): void => {
    for (const node of nodes) {
      if (node.type === "code") {
        fences.push(node);
      } else if (node.type === "list") {
        for (const item of node.items) visit(item.children);
      } else if (node.type === "blockquote" || node.type === "callout") {
        visit(node.children);
      }
    }
  };
  visit(parseMarkdownDocument(markdown).children);
  const found = fences.find(isPromptFence);
  if (!found) {
    throw new Error("onboarding prompt source carries no ```text prompt block");
  }
  const text = found.value.trim();
  // A fence line inside the prompt cannot round-trip through `promptFence`,
  // so fail loudly instead of shipping a truncated block.
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      throw new Error("onboarding prompt contains a fence line");
    }
  }
  return text;
}

// Published `.md` stays a complete, self-contained prompt for agents. The
// meta tag survives into the HTML view, where the code-block extension
// reads it back as the onboarding copy label.
export function promptFence(prompt: string): string {
  return [`\`\`\`text ${PROMPT_FENCE_META}`, prompt, "```"].join("\n");
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

// Assembly resolves the prompt marker to a fence before parsing, so the
// code-block extension renders the figure straight from the AST —
// including blank lines, which survive inside fenced blocks.
