/**
 * Link checker for the published docs site.
 *
 * The checked tree is the Pages artifact, not the repo: check roots are
 * discovered by walking the assembled tree for HTML/markdown pages, and
 * `checkPublishedSite` assembles the publish set (see assemble.ts) into a
 * temp dir before validating it there. Green docs:check therefore means
 * the Pages URLs resolve.
 *
 * Standing rule: ADRs are maintainer internals and MUST NEVER reach the
 * consumer surface. `check` therefore also fails closed on any ADR file or
 * ADR mention in the assembled tree (see `isAdrPath` / `findAdrMention`).
 * Keep `docs/adr` out of the publish manifest in assemble.ts and keep ADR
 * pointers out of every published page.
 *
 * Pages is a static file host: a link target must be a file (a directory
 * only counts when it carries its own index.html — Pages serves that, but
 * never a generated listing). This intentionally differs from GitHub's UI,
 * which renders bare directory links.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assembleSite, listFilesRecursive, repoRootDir } from "./assemble.ts";

export type CheckPaths = {
  rootDir: string;
  htmlFiles: string[];
  markdownFiles: string[];
};

/**
 * Check roots: every HTML/markdown page in the assembled tree. Takes the
 * assembled site root explicitly — there is no repo-root default, so a bare
 * call can never silently reintroduce "check the repo, not the artifact".
 */
export async function defaultCheckPaths(rootDir: string): Promise<CheckPaths> {
  const htmlFiles: string[] = [];
  const markdownFiles: string[] = [];

  for (const abs of await listFilesRecursive(rootDir)) {
    if (abs.endsWith(".html")) htmlFiles.push(abs);
    else if (abs.endsWith(".md")) markdownFiles.push(abs);
  }

  return { rootDir, htmlFiles, markdownFiles };
}

/** Static-host rule: a file, or a directory served via its index.html. */
async function siteTargetExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (st.isFile()) return true;
    if (st.isDirectory()) {
      try {
        return (await stat(join(path, "index.html"))).isFile();
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function assertHref(href: string, fromFile: string): Promise<void> {
  if (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#")
  ) {
    return;
  }

  const [pathPart] = href.split("#");
  if (!pathPart) return;

  const resolved = resolve(dirname(fromFile), pathPart);
  if (!(await siteTargetExists(resolved))) {
    throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
  }
}

export function extractHtmlHrefs(html: string): string[] {
  const targets: string[] = [];
  const re = /href="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    targets.push(match[1]!);
  }
  return targets;
}

export function extractMarkdownDestinations(text: string): string[] {
  const targets: string[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    targets.push(match[2]!);
  }
  return targets;
}

/**
 * True when a published relative path is an ADR file: any path segment
 * equals `adr` (case-insensitive), covering `docs/adr/...` regardless of
 * where the artifact root sits.
 */
export function isAdrPath(relPath: string): boolean {
  return relPath
    .split("/")
    .some((segment) => segment.toLowerCase() === "adr");
}

/**
 * First ADR mention in page text, if any. Matches the standalone word
 * `ADR`/`ADRs` (any case, so `see ADR 0007` and `adrs` both trip) or an
 * `adr/` link prefix (any case, so `docs/adr/`, `../adr/` both trip).
 * The `\b` / `/` anchors keep ordinary words like `address` green.
 */
export function findAdrMention(text: string): string | null {
  const re = /\bADRs?\b|adr\//i;
  const match = re.exec(text);
  return match ? match[0]! : null;
}

export async function check(paths: CheckPaths): Promise<void> {
  // Read every page body before starting any link assert, so no assert
  // promise can reject while a later readFile await is still in flight
  // (Bun would report that as an unhandled rejection).
  const pages = await Promise.all([
    ...paths.htmlFiles.map(async (file) => {
      const text = await readFile(file, "utf8");
      return { file, text, hrefs: extractHtmlHrefs(text) };
    }),
    ...paths.markdownFiles.map(async (file) => {
      const text = await readFile(file, "utf8");
      return { file, text, hrefs: extractMarkdownDestinations(text) };
    }),
  ]);

  // Standing rule: ADRs never ship to consumers. Fail closed on ADR files
  // or ADR mentions so a re-added `docs/adr` publish entry or a stray
  // `see ADR …` pointer breaks the docs build instead of leaking. Runs
  // before link asserts so an ADR leak reports as such even when its
  // target is also missing from the artifact.
  const adrLeaks: string[] = [];
  for (const { file, text } of pages) {
    const rel = file.slice(paths.rootDir.length + 1);
    if (isAdrPath(rel)) {
      adrLeaks.push(`ADR file in consumer surface: ${rel}`);
      continue;
    }
    const mention = findAdrMention(text);
    if (mention) {
      adrLeaks.push(`ADR mention in ${rel}: ${JSON.stringify(mention)}`);
    }
  }
  if (adrLeaks.length > 0) {
    throw new Error(
      `ADR leak (ADRs are maintainer internals, never consumer docs):\n${adrLeaks.join("\n")}`,
    );
  }

  const results = await Promise.allSettled(
    pages.flatMap(({ file, hrefs }) =>
      hrefs.map((href) => assertHref(href, file)),
    ),
  );
  const failures = results.flatMap((r) =>
    r.status === "rejected"
      ? [r.reason instanceof Error ? r.reason.message : String(r.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(`dead links:\n${failures.join("\n")}`);
  }

  const relative = [
    ...paths.htmlFiles.map((p) => p.slice(paths.rootDir.length + 1)),
    ...paths.markdownFiles.map((p) => p.slice(paths.rootDir.length + 1)),
  ];
  console.log(`docs links OK (${relative.join(" + ")})`);
}

/**
 * Assemble the publish set into a temp dir and check that tree, so the gate
 * proves Pages URLs — not just that targets exist somewhere in the repo.
 */
export async function checkPublishedSite(
  repoRoot: string = repoRootDir,
): Promise<void> {
  const siteRoot = await mkdtemp(join(tmpdir(), "sprout-docs-site-"));
  try {
    await assembleSite(repoRoot, siteRoot);
    await check(await defaultCheckPaths(siteRoot));
  } finally {
    await rm(siteRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  // With a directory argument, check that assembled tree in place (CI
  // assembles once, then gates the artifact it will upload). Without one,
  // assemble to a temp dir and check that (local `bun run docs:check`).
  const [siteRootArg] = process.argv.slice(2);
  if (siteRootArg) await check(await defaultCheckPaths(resolve(siteRootArg)));
  else await checkPublishedSite();
}
