import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SITE_ORIGIN, assembleSite, listFilesRecursive, repoRootDir } from "./assemble.ts";
import {
  extractHtmlIds,
  isExternalHref,
  markdownToHtmlBody,
  splitHref,
} from "./markdown.ts";
import { findAdrMention, isAdrHref, isAdrPath } from "./adr-policy.ts";

export type CheckedFileKind = "html" | "markdown" | "text";
export type CheckedFile = { path: string; kind: CheckedFileKind };
export type CheckPaths = { rootDir: string; files: CheckedFile[] };

export async function defaultCheckPaths(rootDir: string): Promise<CheckPaths> {
  const files: CheckedFile[] = [];
  for (const abs of await listFilesRecursive(rootDir)) {
    if (abs.endsWith(".html")) files.push({ path: abs, kind: "html" });
    else if (abs.endsWith(".md"))
      files.push({ path: abs, kind: "markdown" });
    else if (abs.endsWith(".txt")) files.push({ path: abs, kind: "text" });
  }
  return { rootDir, files };
}

// Pages serves a directory only via its own index.html, never a generated listing.
async function resolveSiteTarget(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (st.isFile()) return path;
    if (st.isDirectory()) {
      const index = join(path, "index.html");
      try {
        return (await stat(index)).isFile() ? index : null;
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

type HrefContext = {
  rootDir: string;
  texts: Map<string, string>;
};

async function readCached(ctx: HrefContext, abs: string): Promise<string> {
  const hit = ctx.texts.get(abs);
  if (hit !== undefined) return hit;
  const text = await readFile(abs, "utf8");
  ctx.texts.set(abs, text);
  return text;
}

// Heading ids of a link target, rendered through the same parser that ships
// the HTML view (GitHub slugs in both), so md fragments and html ids share
// one namespace instead of the gate validating the renderer against itself.
async function targetIds(abs: string, ctx: HrefContext): Promise<Set<string> | null> {
  if (abs.endsWith(".html")) {
    return new Set(extractHtmlIds(await readCached(ctx, abs)));
  }
  if (abs.endsWith(".md")) {
    return new Set(extractHtmlIds(markdownToHtmlBody(await readCached(ctx, abs))));
  }
  return null;
}

async function assertHref(
  href: string,
  fromFile: string,
  ctx: HrefContext,
): Promise<void> {
  // Absolute index links resolve against the checked tree, not the network.
  const absolute = href.startsWith(`${SITE_ORIGIN}/`);
  const raw = absolute ? href.slice(SITE_ORIGIN.length + 1) : href;
  const baseDir = absolute ? ctx.rootDir : dirname(fromFile);
  if (isExternalHref(raw)) return;
  const { path, fragment } = splitHref(raw);
  const resolved = path
    ? await resolveSiteTarget(resolve(baseDir, path))
    : fromFile;
  if (resolved === null) {
    throw new Error(
      `dead link in ${fromFile}: ${href} → ${resolve(baseDir, path)}`,
    );
  }
  if (fragment !== null && fragment !== "") {
    const ids = await targetIds(resolved, ctx);
    if (ids && !ids.has(fragment)) {
      throw new Error(
        `dead fragment in ${fromFile}: ${href} → #${fragment} missing in ${resolved}`,
      );
    }
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

// Bare same-site URLs (the onboarding prompt lists them as plain text, not
// links) are gated too. Only the site origin qualifies: placeholders and
// external hosts stay out, exactly like the link gate itself.
export function extractBareSiteUrls(text: string): string[] {
  const targets: string[] = [];
  const re = new RegExp(
    `${SITE_ORIGIN.replace(/\./g, "\\.")}[^\\s)"'\\]]*`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    targets.push(match[0]!.replace(/[.,;:!?]+$/, ""));
  }
  return targets;
}

export function extractHrefs(text: string, kind: CheckedFileKind): string[] {
  if (kind === "html") return extractHtmlHrefs(text);
  return [...extractMarkdownDestinations(text), ...extractBareSiteUrls(text)];
}

export type LoadedPage = { file: string; text: string; hrefs: string[] };

async function loadPages(paths: CheckPaths): Promise<LoadedPage[]> {
  return Promise.all(
    paths.files.map(async ({ path, kind }) => {
      const text = await readFile(path, "utf8");
      return { file: path, text, hrefs: extractHrefs(text, kind) };
    }),
  );
}

async function collectAdrLeaks(
  paths: CheckPaths,
  pages: LoadedPage[],
): Promise<string[]> {
  const adrLeaks: string[] = [];

  for (const abs of await listFilesRecursive(paths.rootDir)) {
    const rel = abs.slice(paths.rootDir.length + 1);
    if (isAdrPath(rel)) {
      adrLeaks.push(`ADR file in consumer surface: ${rel}`);
    }
  }

  for (const { file, text, hrefs } of pages) {
    const rel = file.slice(paths.rootDir.length + 1);
    if (isAdrPath(rel)) continue;
    const mention = findAdrMention(text);
    if (mention) {
      adrLeaks.push(`ADR mention in ${rel}: ${JSON.stringify(mention)}`);
    }
    for (const href of hrefs) {
      if (isAdrHref(href)) {
        adrLeaks.push(`ADR link in ${rel}: ${JSON.stringify(href)}`);
      }
    }
  }

  return adrLeaks;
}

export async function assertNoAdrLeaks(
  paths: CheckPaths,
  pages: LoadedPage[],
): Promise<void> {
  const adrLeaks = await collectAdrLeaks(paths, pages);
  if (adrLeaks.length > 0) {
    throw new Error(
      `ADR leak (ADRs are maintainer internals, never consumer docs):\n${adrLeaks.join("\n")}`,
    );
  }
}

export async function check(paths: CheckPaths): Promise<void> {
  // Load every page before asserting so Bun never reports an unhandled rejection.
  const pages = await loadPages(paths);
  await assertNoAdrLeaks(paths, pages);

  const ctx: HrefContext = {
    rootDir: paths.rootDir,
    texts: new Map(pages.map((p) => [p.file, p.text])),
  };
  const results = await Promise.allSettled(
    pages.flatMap(({ file, hrefs }) =>
      hrefs.map((href) => assertHref(href, file, ctx)),
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

  const relative = paths.files.map((f) => f.path.slice(paths.rootDir.length + 1));
  console.log(`docs links OK (${relative.join(" + ")})`);
}

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
  const [siteRootArg] = process.argv.slice(2);
  if (siteRootArg) await check(await defaultCheckPaths(resolve(siteRootArg)));
  else await checkPublishedSite();
}
