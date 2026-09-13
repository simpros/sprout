/**
 * Single manifest for the published docs corpus.
 *
 * Both the Pages artifact builder and the link checker derive from this
 * module, so the checked tree and the published tree cannot drift apart:
 * assemble copies exactly the published set (preserving repo-relative
 * paths, so relative hrefs resolve identically), and the checker validates
 * that assembled tree with static-host semantics.
 */
import { cp, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
export const repoRootDir = resolve(siteDir, "../..");

/** URL path of the docs front door, relative to the site root. */
export const siteEntryPath = "docs/site/index.html";

/** Repo-relative files published to Pages with a verbatim layout. */
export const publishFiles = [
  "README.md",
  "CONTEXT.md",
  "compose.env.example",
  ".env.example",
  "docs/deploy.md",
  "docs/adoption.md",
  "docs/site/index.html",
  "docs/adr/README.md",
  "examples/adopting-repo/README.md",
  "e2e/README.md",
  "deploy/traefik/README.md",
  "deploy/traefik/certificates-resolver.dns.yml",
  "deploy/traefik/wildcard-bootstrap.compose.yml",
  "deploy/postgres/ensure-preview-role.sh",
];

/**
 * Repo-relative directories published wholesale. Deep links from published
 * pages (adoption.md → templates, adopting-repo scripts/workflows) keep
 * working without tracking each target file here.
 */
export const publishDirs = ["templates", "examples/adopting-repo"];

const adrDirRel = "docs/adr";

async function walkFiles(root: string, rel: string, out: string[]): Promise<void> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const child = join(rel, entry.name);
    if (entry.isDirectory()) await walkFiles(root, child, out);
    else out.push(child);
  }
}

/** Markdown pages inside the published trees that carry checkable links. */
export async function listPublishedMarkdown(repoRoot: string): Promise<string[]> {
  const rel = [
    "README.md",
    "CONTEXT.md",
    "docs/deploy.md",
    "docs/adoption.md",
    "examples/adopting-repo/README.md",
    "e2e/README.md",
    "deploy/traefik/README.md",
    "templates/README.md",
  ];
  for (const entry of await readdir(join(repoRoot, adrDirRel))) {
    if (entry.endsWith(".md")) rel.push(join(adrDirRel, entry));
  }
  return [...new Set(rel)].sort().map((p) => join(repoRoot, p));
}

/** Root redirect equivalent to the docs:preview `/` → entry redirect. */
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

/**
 * Copy the publish set from repoRoot into outDir, preserving repo-relative
 * paths. Returns the published repo-relative paths (plus `index.html`).
 */
export async function assembleSite(
  repoRoot: string,
  outDir: string,
): Promise<string[]> {
  const published: string[] = [];

  for (const file of publishFiles) {
    const dest = join(outDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(repoRoot, file), dest);
    published.push(file);
  }

  for (const entry of await readdir(join(repoRoot, adrDirRel))) {
    if (entry === "README.md" || !entry.endsWith(".md")) continue;
    const rel = join(adrDirRel, entry);
    const dest = join(outDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(repoRoot, rel), dest);
    published.push(rel);
  }

  for (const dir of publishDirs) {
    await cp(join(repoRoot, dir), join(outDir, dir), { recursive: true });
    await walkFiles(repoRoot, dir, published);
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
