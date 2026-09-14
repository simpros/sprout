/**
 * Single manifest for the published docs corpus.
 *
 * `publishFiles` + `publishDirs` is the sole allowlist: the Pages artifact
 * builder copies exactly this set (preserving repo-relative paths, so
 * relative hrefs resolve identically), and the checker discovers its check
 * roots by walking the assembled tree — so the checked tree and the
 * published tree cannot drift apart.
 *
 * Standing rule: ADRs are maintainer internals and MUST NEVER reach the
 * consumer surface. `docs/adr` is therefore NOT published, and the link
 * checker (see check.ts) fails closed on any ADR file or mention that lands
 * in the assembled tree.
 */
import { cp, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
export const repoRootDir = resolve(siteDir, "../..");

/** URL path of the docs front door, relative to the site root. */
export const siteEntryPath = "docs/site/index.html";

/**
 * Repo-relative files published to Pages with a verbatim layout.
 * Directory trees below cover their own members (including READMEs), so
 * only standalone files are listed here.
 */
export const publishFiles = [
  "README.md",
  "CONTEXT.md",
  "LICENSE",
  "compose.env.example",
  ".env.example",
  "docs/deploy.md",
  "docs/adoption.md",
  "docs/site/index.html",
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
export const publishDirs = [
  "templates",
  "examples/adopting-repo",
];

/** Recursively list every file under root as absolute paths. */
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
 * paths. outDir is replaced, not merged: it is wiped first so a shrunken
 * manifest or a dirty workspace cannot leave stale orphans behind in the
 * uploaded artifact. Returns the published repo-relative paths
 * (plus `index.html`).
 */
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

  await writeFile(join(outDir, "index.html"), rootRedirectHtml());
  published.push("index.html");

  return published.sort();
}

if (import.meta.main) {
  const outDir = resolve(repoRootDir, "_site");
  const published = await assembleSite(repoRootDir, outDir);
  console.log(`docs site assembled → ${outDir} (${published.length} paths)`);
}
