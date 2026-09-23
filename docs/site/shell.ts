// Single-source page chrome for the published docs site.
//
// The marketing page and every docs page share one stylesheet (`theme.css`,
// inlined) and one header/footer built here, by construction: `renderShell`
// is the only way to produce a published `.html` page. The prompt marker is
// the one assembly-resolved marker left; the gate asserts none survives.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeBlockScript } from "./codeblock.ts";
import { escapeHtml } from "./html.ts";

export const PROMPT_MARKER = "<!-- docs-onboarding-prompt -->";

export function hasUnresolvedMarkers(text: string): boolean {
  return text.includes("<!-- docs-");
}

let cachedTheme: string | null = null;

// The theme file is the only copy: every page inlines this same text.
export function themeCss(): string {
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

// One constant per artifact location: every page's depth-derived strings
// (brand home, root/docs relatives) come from here, so call sites cannot
// hand-compute a wrong `..`. The docs-nav prefix restates `toDocs`
// (`.` → `""`, `..` → `"../"`), so it is derived, never set.
export type SiteLocation = {
  homeHref: string;
  toRoot: string;
  toDocs: string;
};

export function navPrefix(location: SiteLocation): string {
  return location.toDocs === "." ? "" : `${location.toDocs}/`;
}

export const docsLocation: SiteLocation = {
  homeHref: "site/index.html",
  toRoot: "..",
  toDocs: ".",
};

export const marketingLocation: SiteLocation = {
  homeHref: "index.html",
  toRoot: "../..",
  toDocs: "..",
};

export type ShellTocEntry = {
  id: string;
  text: string;
  level: number;
};

export function siteHeader(homeHref: string, nav: ShellNavItem[]): string {
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

export function siteFooter(toRoot: string, toDocs: string): string {
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
export function renderToc(headings: ShellTocEntry[]): string {
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
  location: SiteLocation;
  nav: ShellNavItem[];
  toc: ShellTocEntry[];
  bodyHtml: string;
};

export function renderShell(opts: ShellOptions): string {
  const toc = renderToc(opts.toc);
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
    siteHeader(opts.location.homeHref, opts.nav),
    "<main>",
    ...(toc === "" ? [] : [toc]),
    opts.bodyHtml,
    "</main>",
    siteFooter(opts.location.toRoot, opts.location.toDocs),
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

// Marketing source handling: the file is a body fragment, not a document —
// title and description travel in the manifest next to `docsPages`, and the
// shell supplies the shared theme, header, footer, and copy script around
// the fragment. The only substitution is the prompt marker.
export function assembleMarketingPage(
  fragment: string,
  opts: {
    title: string;
    description: string;
    promptFigure: string;
    nav: ShellNavItem[];
  },
): string {
  return renderShell({
    title: opts.title,
    description: opts.description,
    location: marketingLocation,
    nav: opts.nav,
    toc: [],
    bodyHtml: fragment.split(PROMPT_MARKER).join(opts.promptFigure),
  });
}
