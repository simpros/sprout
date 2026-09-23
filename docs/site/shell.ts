// Single-source page chrome for the published docs site.
//
// The marketing page and every docs page share one stylesheet (`theme.css`,
// inlined) and one header/footer built here, by construction: `renderShell`
// is the only way to produce a published `.html` page. The prompt marker is
// the one assembly-resolved marker left; the link-check gate asserts none
// survives.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dirname as posixDirname, relative as posixRelative } from "node:path/posix";
import { fileURLToPath } from "node:url";
import { codeBlockScript } from "./codeblock.ts";
import { escapeHtml } from "./html.ts";

export const PROMPT_MARKER = "<!-- docs-onboarding-prompt -->";

// Artifact path of the marketing entry, relative to the repo root. Assembly
// re-exports this so the manifest and the chrome agree on one string.
export const siteEntryPath = "docs/site/index.html";

let cachedTheme: string | null = null;

// The theme file is the only copy: every page inlines this same text.
function themeCss(): string {
  if (cachedTheme === null) {
    const dir = dirname(fileURLToPath(import.meta.url));
    cachedTheme = readFileSync(join(dir, "theme.css"), "utf8");
  }
  return cachedTheme;
}

export type ShellNavItem = {
  href: string;
  title: string;
  current?: boolean;
};

// Depth-derived strings come from the artifact path being written, so a new
// depth is correct by construction instead of needing a hand-set constant.
function locationFor(outputPath: string): {
  homeHref: string;
  toRoot: string;
  toDocs: string;
} {
  const dir = posixDirname(outputPath);
  const toRoot = posixRelative(dir, ".") || ".";
  const toDocs = posixRelative(dir, "docs") || ".";
  return {
    homeHref: posixRelative(dir, siteEntryPath),
    toRoot,
    toDocs,
  };
}

export function navPrefixFor(outputPath: string): string {  const toDocs = posixRelative(posixDirname(outputPath), "docs") || ".";
  return toDocs === "." ? "" : `${toDocs}/`;
}

export type ShellTocEntry = {
  id: string;
  text: string;
  level: number;
};

function siteHeader(homeHref: string, nav: ShellNavItem[]): string {
  const links = nav
    .map(
      (item) =>
        `      <a href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ""}>${escapeHtml(item.title)}</a>`,
    )
    .join("\n");
  return [
    `<header class="site">`,
    `  <p class="brand"><a href="${escapeHtml(homeHref)}">sprout</a></p>`,
    `  <nav class="docs-nav" aria-label="Docs">`,
    links,
    `  </nav>`,
    `</header>`,
  ].join("\n");
}

function siteFooter(toRoot: string, toDocs: string): string {
  return [
    `<footer id="docs">`,
    `  <p>`,
    `    Docs: <a href="${toDocs}/index.html">docs index</a> ·`,
    `    <a href="${toRoot}/llms.txt">llms.txt</a> ·`,
    `    <a href="${toDocs}/onboarding-prompt.html">onboarding prompt</a> ·`,
    `    <a href="${toDocs}/getting-started.html">getting started</a> ·`,
    `    <a href="${toRoot}/examples/adopting-repo/README.md">adopting-repo example</a> ·`,
    `    <a href="https://github.com/simpros/sprout">simpros/sprout</a>.`,
    `    Published from <code>docs/site/</code> via GitHub Pages.`,
    `  </p>`,
    `</footer>`,
  ].join("\n");
}

// The "On this page" index, straight from the parsed document headings —
// hrefs live in the same `headingIds` namespace as the rendered headings.
function renderToc(headings: ShellTocEntry[]): string {
  const entries = headings.filter((h) => h.level > 1);
  if (entries.length === 0) return "";
  const items = entries
    .map(
      (h) =>
        `      <li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`,
    )
    .join("\n");
  return [
    `<nav class="toc-page" aria-label="On this page">`,
    `  <p>On this page</p>`,
    `  <ul>`,
    items,
    `  </ul>`,
    `</nav>`,
  ].join("\n");
}

export type ShellOptions = {
  title: string;
  description: string;
  outputPath: string;
  nav: ShellNavItem[];
  toc: ShellTocEntry[];
  bodyHtml: string;
};

export function renderShell(opts: ShellOptions): string {
  const toc = renderToc(opts.toc);
  const location = locationFor(opts.outputPath);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<meta name="description" content="${escapeHtml(opts.description)}" />`,
    "<style>",
    themeCss(),
    "</style>",
    "</head>",
    "<body>",
    '<div class="wrap">',
    siteHeader(location.homeHref, opts.nav),
    "<main>",
    ...(toc === "" ? [] : [toc]),
    opts.bodyHtml,
    "</main>",
    siteFooter(location.toRoot, location.toDocs),
    '<div class="codeblock-status" aria-live="polite"></div>',
    "</div>",
    "<script>",
    codeBlockScript,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
