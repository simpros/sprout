import { cp, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promptFigure } from "./codeblock.ts";
import { escapeHtml } from "./html.ts";
import {
  docsPrefixFor,
  marketingSourcePath,
  PROMPT_MARKER,
  renderShell,
  siteEntryPath,
  type ShellNavItem,
} from "./shell.ts";
import {
  extractPromptText,
  promptFence,
  renderMarkdown,
  rewritePageLinks,
} from "./markdown.ts";

export { marketingSourcePath, siteEntryPath };

const siteDir = dirname(fileURLToPath(import.meta.url));
export const repoRootDir = resolve(siteDir, "../..");

// Agent-facing origin for absolute index links; shared with the link checker
// so generated URLs and the gate resolve against one source of truth.
export const SITE_ORIGIN = "https://simpros.github.io/sprout";

export type DocsPage = {
  file: string;
  title: string;
  description: string;
  entry?: boolean;
};

// The only description of the page set: the publish list, the rendered HTML,
// docs/index.html, and llms.txt are all derived from this.
export const docsPages: DocsPage[] = [
  { file: "docs/getting-started.md", title: "Getting started", description: "first preview in one sitting." },
  { file: "docs/adopting-a-repo.md", title: "Adopting a repo", description: "sprout.yaml manifest reference and app entrypoints." },
  { file: "docs/ci-integration.md", title: "CI integration", description: "GitLab component, GitHub reusable workflow, variables, reset, notes." },
  { file: "docs/previews.md", title: "Previews", description: "lifecycle: database providers, seeding, services, mail." },
  { file: "docs/operator-deploy.md", title: "Operator deploy", description: "gateway compose stack, Traefik, env reference, admin token." },
  { file: "docs/cli-reference.md", title: "CLI reference", description: "every sprout command, debugging, tokens." },
  { file: "docs/troubleshooting.md", title: "Troubleshooting", description: "adopter and operator error catalogue." },
  { file: "docs/onboarding-prompt.md", title: "Onboarding prompt", description: "copy-paste agent block (entry point for agents).", entry: true },
  { file: "docs/herdr-integration.md", title: "Herdr integration", description: "operator-side review automation." },
];

// The marketing page in the same manifest shape as every docs page: the
// source fragment carries no envelope, so its title and description live
// here, next to `docsPages`.
export const marketingPage: DocsPage = {
  file: siteEntryPath,
  title: "sprout — every pull request gets its own preview",
  description:
    "sprout gives every pull request an isolated database and a live preview app on shared infrastructure you host yourself.",
};

// The `.md → .html` mapping, derived once: source path, artifact path, and
// the docs-relative href the index links with.
export function pageHtmlFile(file: string): string {
  return file.replace(/\.md$/, ".html");
}

export function pageIndexHref(page: DocsPage): string {
  return pageHtmlFile(page.file).replace(/^docs\//, "");
}

function docsEntry(): DocsPage {
  const entry = docsPages.find((p) => p.entry);
  if (!entry) throw new Error("docsPages has no entry page");
  return entry;
}

function renderedHtmlPages(): Set<string> {
  return new Set(docsPages.map((p) => pageHtmlFile(p.file)));
}

export function renderDocsIndexHtml(): string {
  const item = (p: DocsPage) =>
    `      <li><a href="${pageIndexHref(p)}">${escapeHtml(p.title)}</a> — ${escapeHtml(p.description)}</li>`;
  const entryHref = pageIndexHref(docsEntry());
  const bodyHtml = [
    "    <h1>sprout docs</h1>",
    `    <p>Markdown is canonical: every page below is served as plain <code>.md</code> (agents) and as rendered <code>.html</code> (humans) from the same source. Machine-readable index: <a href="../llms.txt">llms.txt</a>. Start with the <a href="${entryHref}">onboarding prompt</a>.</p>`,
    "    <ul>",
    ...docsPages.map(item),
    "    </ul>",
  ].join("\n");
  return renderShell({
    title: "sprout docs",
    description:
      "sprout docs: adopting repos, CI wiring, previews, operator deploy, CLI, troubleshooting.",
    outputPath: "docs/index.html",
    nav: docsNav("docs/index.html"),
    toc: [],
    bodyHtml,
  });
}

// Docs nav straight from the page manifest, so a new page appears
// automatically. The `docs/ ↔ docs/site/` depth gap is derived from the
// artifact path being written, never hand-set per call.
export function docsNav(outputPath: string, current?: string): ShellNavItem[] {
  const prefix = docsPrefixFor(outputPath);
  return docsPages.map((p) => ({
    href: `${prefix}${pageIndexHref(p)}`,
    title: p.title,
    ...(current === p.file ? { current: true as const } : {}),
  }));
}

// Machine-readable agent index; the checked-in root copy serves raw GitHub
// fetches, the assembled copy serves Pages.
export function renderLlmsTxt(): string {
  const onboarding = docsEntry();
  const rest = docsPages.filter((p) => p !== onboarding);
  const lines = [onboarding, ...rest].map(
    (p) => `- [${p.title}](${SITE_ORIGIN}/${p.file}): ${p.description}`,
  );
  return ["These docs are for agents. Start with the onboarding prompt.", ...lines, ""].join("\n");
}

// Raw copies; docs pages, the rendered marketing page, and generated
// indexes join via docsPages below.
const copyOnlyFiles = [
  "README.md",
  "CONTEXT.md",
  "LICENSE",
  "compose.env.example",
  ".env.example",
  "e2e/README.md",
  "deploy/traefik/README.md",
  "deploy/coolify/README.md",
  "deploy/coolify/gateway.compose.yml",
  "deploy/traefik/certificates-resolver.dns.yml",
  "deploy/traefik/wildcard-bootstrap.compose.yml",
  "deploy/postgres/ensure-preview-role.sh",
];

const generatedFiles = ["docs/index.html", "llms.txt", siteEntryPath];

export const publishFiles = [
  ...copyOnlyFiles,
  marketingSourcePath,
  ...docsPages.map((p) => p.file),
  ...generatedFiles,
];

export const publishDirs = [
  "templates",
  "examples/adopting-repo",
];

export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  await walk(root);
  return out.sort();
}

export function rootRedirectHtml(): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<meta http-equiv="refresh" content="0; url=${siteEntryPath}" />`,
    `<link rel="canonical" href="${siteEntryPath}" />`,
    "<title>sprout docs</title>",
    "</head>",
    "<body>",
    `<p><a href="${siteEntryPath}">sprout docs</a></p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export async function assembleSite(
  repoRoot: string,
  outDir: string,
): Promise<string[]> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const published: string[] = [];

  for (const file of copyOnlyFiles) {
    const dest = join(outDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(repoRoot, file), dest);
    published.push(file);
  }

  for (const dir of publishDirs) {
    await cp(join(repoRoot, dir), join(outDir, dir), { recursive: true });
    for (const abs of await listFilesRecursive(join(repoRoot, dir))) {
      published.push(relative(repoRoot, abs));
    }
  }

  await mkdir(join(outDir, "docs"), { recursive: true });
  await writeFile(join(outDir, "docs/index.html"), renderDocsIndexHtml());
  published.push("docs/index.html");
  await writeFile(join(outDir, "llms.txt"), renderLlmsTxt());
  published.push("llms.txt");

  // The onboarding prompt lives in one source file; pages carrying the
  // marker embed it. It is a docsPage, read unconditionally below, so
  // extract it eagerly here: one extraction, one substitution helper for
  // both surfaces.
  const prompt = extractPromptText(
    await readFile(join(repoRoot, docsEntry().file), "utf8"),
  );
  const resolvePrompt = (
    text: string,
    render: (prompt: string) => string,
  ): string => text.split(PROMPT_MARKER).join(render(prompt));

  const htmlPages = renderedHtmlPages();
  for (const page of docsPages) {
    const { file } = page;
    const source = await readFile(join(repoRoot, file), "utf8");
    // One substitution: the resolved fence feeds both the `.md` write and
    // the HTML render, so the parser owns the figure on both surfaces.
    // A marker-free source passes through untouched.
    const markdownForMd = resolvePrompt(source, promptFence);
    const dest = join(outDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, markdownForMd);
    published.push(file);
    const htmlFile = pageHtmlFile(file);
    // Page composition lives here, with the other `renderShell` call sites:
    // parse once, rewrite `.md` links to `.html` twins, wrap in the shell.
    const { headings, body } = renderMarkdown(markdownForMd);
    await writeFile(
      join(outDir, htmlFile),
      renderShell({
        title: page.title,
        description: page.description,
        outputPath: htmlFile,
        nav: docsNav(htmlFile, file),
        toc: headings,
        bodyHtml: rewritePageLinks(body, file, htmlPages),
      }),
    );
    published.push(htmlFile);
  }

  const marketingSource = await readFile(join(repoRoot, marketingSourcePath), "utf8");
  await mkdir(dirname(join(outDir, siteEntryPath)), { recursive: true });
  await writeFile(
    join(outDir, siteEntryPath),
    renderShell({
      title: marketingPage.title,
      description: marketingPage.description,
      outputPath: siteEntryPath,
      nav: docsNav(siteEntryPath),
      toc: [],
      bodyHtml: resolvePrompt(marketingSource, promptFigure),
    }),
  );
  published.push(siteEntryPath);

  await writeFile(join(outDir, "index.html"), rootRedirectHtml());
  published.push("index.html");

  return published.sort();
}

if (import.meta.main) {
  const outDir = resolve(repoRootDir, "_site");
  const published = await assembleSite(repoRootDir, outDir);
  console.log(`docs site assembled → ${outDir} (${published.length} paths)`);
}
