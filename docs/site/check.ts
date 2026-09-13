/**
 * Link checker for the public docs site, README front door, and operator
 * deploy guide. There is no build output: preview serves the source files
 * directly.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(siteDir, "../..");

export type CheckPaths = {
  rootDir: string;
  htmlFiles: string[];
  markdownFiles: string[];
};

export function defaultCheckPaths(rootDir = defaultRootDir): CheckPaths {
  return {
    rootDir,
    htmlFiles: [join(rootDir, "docs/site/index.html")],
    markdownFiles: [
      join(rootDir, "README.md"),
      join(rootDir, "docs/deploy.md"),
    ],
  };
}

async function localTargetExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preview serves files (Bun.file), not directories: a bare directory 404s
 * unless it contains an index.html. HTML hrefs must satisfy the same rule
 * or docs:check goes green while docs:preview 404s. README / markdown links
 * keep the lenient rule — those surfaces are browsed on GitHub (or as
 * static .md on Pages), where directory links are acceptable.
 */
async function htmlTargetExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (st.isFile()) return true;
    if (st.isDirectory()) return await localTargetExists(join(path, "index.html"));
    return false;
  } catch {
    return false;
  }
}

async function assertHref(
  href: string,
  fromFile: string,
  exists: (path: string) => Promise<boolean>,
): Promise<void> {
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
  if (!(await exists(resolved))) {
    throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
  }
}

/** Markdown destinations: files or directories (GitHub renders dirs). */
async function assertMarkdownHref(href: string, fromFile: string): Promise<void> {
  return assertHref(href, fromFile, localTargetExists);
}

/** HTML hrefs: must be a servable file (or a dir containing index.html). */
async function assertHtmlHref(href: string, fromFile: string): Promise<void> {
  return assertHref(href, fromFile, htmlTargetExists);
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

export async function check(paths: CheckPaths = defaultCheckPaths()): Promise<void> {
  const jobs: Promise<void>[] = [];

  for (const htmlFile of paths.htmlFiles) {
    const html = await readFile(htmlFile, "utf8");
    for (const href of extractHtmlHrefs(html)) {
      jobs.push(assertHtmlHref(href, htmlFile));
    }
  }

  for (const mdFile of paths.markdownFiles) {
    const text = await readFile(mdFile, "utf8");
    for (const href of extractMarkdownDestinations(text)) {
      jobs.push(assertMarkdownHref(href, mdFile));
    }
  }

  const results = await Promise.allSettled(jobs);
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

if (import.meta.main) {
  await check();
}
