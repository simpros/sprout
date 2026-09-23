import { cp, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeBlockFigure } from "./codeblock.ts";
import {
  assembleMarketingPage,
  PROMPT_MARKER,
  renderShell,
  type ShellNavItem,
} from "./shell.ts";
import {
  escapeHtml,
  extractPromptText,
  pageTitle,
  promptFence,
  renderMarkdownPage,
} from "./markdown.ts";

const siteDir = dirname(fileURLToPath(import.meta.url));
export const repoRootDir = resolve(siteDir, "../..");

export const siteEntryPath = "docs/site/index.html";

// Agent-facing origin for absolute index links; shared with the link checker
// so generated URLs and the gate resolve against one source of truth.
export const SITE_ORIGIN = "https://simpros.github.io/sprout";

export type DocsPage = {
  file: string;
  title: string;
  description: string;
  legacy?: boolean;
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
  { file: "docs/adoption.md", title: "Adoption guide", description: "thin map to the per-topic pages (legacy path).", legacy: true },
  { file: "docs/deploy.md", title: "Operator deploy guide", description: "thin map to the operator page (legacy path).", legacy: true },
];

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
  const main = docsPages.filter((p) => !p.legacy);
  const legacy = docsPages.filter((p) => p.legacy);
  const item = (p: DocsPage) =>
    `      <li><a href="${pageIndexHref(p)}">${escapeHtml(p.title)}</a> — ${escapeHtml(p.description)}</li>`;
  const entryHref = pageIndexHref(docsEntry());
  const bodyHtml = [
    "    <h1>sprout docs</h1>",
    `    <p>Markdown is canonical: every page below is served as plain <code>.md</code> (agents) and as rendered <code>.html</code> (humans) from the same source. Machine-readable index: <a href="../llms.txt">llms.txt</a>. Start with the <a href="${entryHref}">onboarding prompt</a>.</p>`,
    "    <ul>",
    ...main.map(item),
    "    </ul>",
    `    <p>Legacy entry points: ${legacy.map((p) => `<a href="${pageIndexHref(p)}">${escapeHtml(p.title)}</a>`).join(", ")} (thin maps to the pages above; old deep links still land).</p>`,
  ].join("\n");
  return renderShell({
    title: "sprout docs",
    description:
      "sprout docs: adopting repos, CI wiring, previews, operator deploy, CLI, troubleshooting.",
    homeHref: "site/index.html",
    toRoot: "..",
    toDocs: ".",
    nav: docsNav(null, ""),
    toc: [],
    bodyHtml,
  });
}

// Docs nav straight from the page manifest, so a new page appears
// automatically. `prefix` bridges the docs/ ↔ docs/site/ depth gap.
export function docsNav(
  currentFile: string | null,
  prefix: string,
): ShellNavItem[] {
  return docsPages.map((p) => ({
    href: `${prefix}${pageIndexHref(p)}`,
    title: p.title,
    ...(p.file === currentFile ? { current: true as const } : {}),
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

const generatedFiles = ["docs/index.html", "llms.txt"];

export const publishFiles = [
  ...copyOnlyFiles,
  siteEntryPath,
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
  // marker embed it. Lazily extracted: fixture trees without a marker never
  // touch the source.
  const onboardingSource = await readFile(
    join(repoRoot, "docs/onboarding-prompt.md"),
    "utf8",
  );
  let cachedPrompt: { text: string; figure: string } | null = null;
  function onboardingPrompt(): { text: string; figure: string } {
    if (!cachedPrompt) {
      const text = extractPromptText(onboardingSource);
      cachedPrompt = {
        text,
        figure: codeBlockFigure("text", text, "Copy onboarding prompt"),
      };
    }
    return cachedPrompt;
  }

  const htmlPages = renderedHtmlPages();
  for (const page of docsPages) {
    const { file } = page;
    const source = await readFile(join(repoRoot, file), "utf8");
    let markdownForMd = source;
    let promptFigure: string | undefined;
    if (source.includes(PROMPT_MARKER)) {
      const prompt = onboardingPrompt();
      markdownForMd = source.split(PROMPT_MARKER).join(promptFence(prompt.text));
      promptFigure = prompt.figure;
    }
    const dest = join(outDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, markdownForMd);
    published.push(file);
    const htmlFile = pageHtmlFile(file);
    const title = pageTitle(source, htmlFile);
    await writeFile(
      join(outDir, htmlFile),
      renderMarkdownPage(title, source, file, htmlPages, {
        description: page.description,
        nav: docsNav(file, ""),
        promptFigure,
      }),
    );
    published.push(htmlFile);
  }

  const marketingSource = await readFile(join(repoRoot, siteEntryPath), "utf8");
  const marketingFigure = marketingSource.includes(PROMPT_MARKER)
    ? onboardingPrompt().figure
    : "";
  await mkdir(dirname(join(outDir, siteEntryPath)), { recursive: true });
  await writeFile(
    join(outDir, siteEntryPath),
    assembleMarketingPage(marketingSource, marketingFigure, docsNav(null, "../")),
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
