import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SITE_ORIGIN, assembleSite, listFilesRecursive, repoRootDir } from "./assemble.ts";
import { extractHtmlIds, markdownToHtmlBody } from "./markdown.ts";
import { findAdrMention, isAdrHref, isAdrPath } from "./adr-policy.ts";

export type CheckPaths = {
  rootDir: string;
  htmlFiles: string[];
  markdownFiles: string[];
  textFiles: string[];
};

export async function defaultCheckPaths(rootDir: string): Promise<CheckPaths> {
  const htmlFiles: string[] = [];
  const markdownFiles: string[] = [];
  const textFiles: string[] = [];

  for (const abs of await listFilesRecursive(rootDir)) {
    if (abs.endsWith(".html")) htmlFiles.push(abs);
    else if (abs.endsWith(".md")) markdownFiles.push(abs);
    else if (abs.endsWith(".txt")) textFiles.push(abs);
  }

  return { rootDir, htmlFiles, markdownFiles, textFiles };
}

// Pages serves a directory only via its own index.html, never a generated listing.
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
// the HTML view so md fragments and html ids cannot disagree.
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
  if (href.startsWith(`${SITE_ORIGIN}/`)) {
    const after = href.slice(SITE_ORIGIN.length + 1);
    const end = Math.min(
      ...["#", "?"].map((c) => {
        const i = after.indexOf(c);
        return i === -1 ? after.length : i;
      }),
    );
    const resolved = resolve(ctx.rootDir, after.slice(0, end));
    if (!(await siteTargetExists(resolved))) {
      throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
    }
    const hash = after.indexOf("#");
    const fragment = hash === -1 ? null : after.slice(hash + 1);
    if (fragment !== null && fragment !== "") {
      const ids = await targetIds(resolved, ctx);
      if (ids && !ids.has(fragment)) {
        throw new Error(
          `dead fragment in ${fromFile}: ${href} → #${fragment} missing in ${resolved}`,
        );
      }
    }
    return;
  }

  if (
    href.startsWith("//") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:")
  ) {
    return;
  }

  const hash = href.indexOf("#");
  const query = href.indexOf("?");
  const end = Math.min(
    hash === -1 ? href.length : hash,
    query === -1 ? href.length : query,
  );
  const pathPart = href.slice(0, end);
  const fragment = hash === -1 ? null : href.slice(hash + 1);

  const resolved = !pathPart ? fromFile : resolve(dirname(fromFile), pathPart);
  let target = resolved;
  if (pathPart) {
    try {
      const st = await stat(resolved);
      if (st.isDirectory()) target = join(resolved, "index.html");
    } catch {
      throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
    }
    if (!(await siteTargetExists(target))) {
      throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
    }
  }

  if (fragment !== null && fragment !== "") {
    const ids = await targetIds(target, ctx);
    if (ids && !ids.has(fragment)) {
      throw new Error(
        `dead fragment in ${fromFile}: ${href} → #${fragment} missing in ${target}`,
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

export type LoadedPage = { file: string; text: string; hrefs: string[] };

async function loadPages(paths: CheckPaths): Promise<LoadedPage[]> {
  return Promise.all([
    ...paths.htmlFiles.map(async (file) => {
      const text = await readFile(file, "utf8");
      return { file, text, hrefs: extractHtmlHrefs(text) };
    }),
    ...paths.markdownFiles.map(async (file) => {
      const text = await readFile(file, "utf8");
      return { file, text, hrefs: extractMarkdownDestinations(text) };
    }),
    ...paths.textFiles.map(async (file) => {
      const text = await readFile(file, "utf8");
      return { file, text, hrefs: extractMarkdownDestinations(text) };
    }),
  ]);
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

  const ctx: HrefContext = { rootDir: paths.rootDir, texts: new Map() };
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

  const relative = [
    ...paths.htmlFiles.map((p) => p.slice(paths.rootDir.length + 1)),
    ...paths.markdownFiles.map((p) => p.slice(paths.rootDir.length + 1)),
    ...paths.textFiles.map((p) => p.slice(paths.rootDir.length + 1)),
  ];
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
