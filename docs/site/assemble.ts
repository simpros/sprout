import { cp, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
export const repoRootDir = resolve(siteDir, "../..");

export const siteEntryPath = "docs/site/index.html";

export const docsPages: { file: string; title: string; description: string }[] = [
  { file: "docs/getting-started.md", title: "Getting started", description: "first preview in one sitting." },
  { file: "docs/adopting-a-repo.md", title: "Adopting a repo", description: "`.sprout.yaml` manifest reference and app entrypoints." },
  { file: "docs/ci-integration.md", title: "CI integration", description: "GitLab component, GitHub reusable workflow, variables, reset, notes." },
  { file: "docs/previews.md", title: "Previews", description: "lifecycle: database providers, seeding, services, mail." },
  { file: "docs/operator-deploy.md", title: "Operator deploy", description: "gateway compose stack, Traefik, env reference, admin token." },
  { file: "docs/cli-reference.md", title: "CLI reference", description: "every `sprout` command, debugging, tokens." },
  { file: "docs/troubleshooting.md", title: "Troubleshooting", description: "adopter and operator error catalogue." },
  { file: "docs/onboarding-prompt.md", title: "Onboarding prompt", description: "copy-paste agent block (entry point for agents)." },
  { file: "docs/herdr-integration.md", title: "Herdr integration", description: "operator-side review automation." },
  { file: "docs/adoption.md", title: "Adopting repo guide", description: "thin map to the per-topic pages (legacy path)." },
  { file: "docs/deploy.md", title: "Operator deployment", description: "thin map to the operator page (legacy path)." },
];

export const publishFiles = [
  "README.md",
  "CONTEXT.md",
  "LICENSE",
  "compose.env.example",
  ".env.example",
  "llms.txt",
  "docs/index.html",
  "docs/deploy.md",
  "docs/adoption.md",
  "docs/getting-started.md",
  "docs/adopting-a-repo.md",
  "docs/ci-integration.md",
  "docs/operator-deploy.md",
  "docs/previews.md",
  "docs/cli-reference.md",
  "docs/troubleshooting.md",
  "docs/onboarding-prompt.md",
  "docs/herdr-integration.md",
  "docs/site/index.html",
  "e2e/README.md",
  "deploy/traefik/README.md",
  "deploy/coolify/README.md",
  "deploy/coolify/gateway.compose.yml",
  "deploy/traefik/certificates-resolver.dns.yml",
  "deploy/traefik/wildcard-bootstrap.compose.yml",
  "deploy/postgres/ensure-preview-role.sh",
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const withCode = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `__SPROUT_CODE_${codeSpans.length - 1}__`;
  });
  const escaped = escapeHtml(withCode);
  const withLinks = escaped.replace(
    /\[([^\]]*)\]\(([^)]+)\)/g,
    (_, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
  const withStrong = withLinks.replace(
    /\*\*([^*]+)\*\*/g,
    (_, bold: string) => `<strong>${bold}</strong>`,
  );
  return withStrong.replace(/__SPROUT_CODE_(\d+)__/g, (_, i: string) => codeSpans[Number(i)]!);
}

function isTableSeparator(line: string): boolean {
  const cells = line.trim().split("|").slice(1, -1);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function renderTableRow(line: string, cell: "td" | "th"): string {
  const cells = line.trim().split("|").slice(1, -1);
  return `<tr>${cells.map((c) => `<${cell}>${renderInline(c.trim())}</${cell}>`).join("")}</tr>`;
}

export function markdownToHtmlBody(markdown: string): string {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let i = 0;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1;
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      html.push("<hr />");
      i += 1;
      continue;
    }
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1]!)
    ) {
      flushParagraph();
      const header = line;
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(lines[i]!);
        i += 1;
      }
      html.push(
        `<table><thead>${renderTableRow(header, "th")}</thead><tbody>${rows.map((r) => renderTableRow(r, "td")).join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^(\s*[-*]\s+)/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^(\s*[-*]\s+)/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^(\s*[-*]\s+)/, ""));
        i += 1;
      }
      html.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      html.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return html.join("\n");
}

export function renderMarkdownPage(title: string, markdown: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    "<main>",
    markdownToHtmlBody(markdown),
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

export async function assembleSite(
  repoRoot: string,
  outDir: string,
): Promise<string[]> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const published: string[] = [];

  for (const file of publishFiles) {
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

  for (const { file } of docsPages) {
    const markdown = await readFile(join(repoRoot, file), "utf8");
    const htmlFile = file.replace(/\.md$/, ".html");
    const title = pageTitle(markdown, htmlFile);
    await writeFile(join(outDir, htmlFile), renderMarkdownPage(title, markdown));
    published.push(htmlFile);
  }

  await writeFile(join(outDir, "index.html"), rootRedirectHtml());
  published.push("index.html");

  return published.sort();
}

if (import.meta.main) {
  const outDir = resolve(repoRootDir, "_site");
  const published = await assembleSite(repoRootDir, outDir);
  console.log(`docs site assembled → ${outDir} (${published.length} paths)`);
}
