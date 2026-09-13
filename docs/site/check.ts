/**
 * Link checker for the public docs site and the README front door.
 * There is no build output: preview serves the source files directly.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(siteDir, "../..");
const srcHtml = join(siteDir, "index.html");
const readmeMd = join(rootDir, "README.md");

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
 * or docs:check goes green while docs:preview 404s. README links keep the
 * lenient rule — that surface is browsed on GitHub, where directory links
 * render as folder listings.
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

/** README destinations: files or directories (GitHub renders dirs). */
async function assertReadmeHref(href: string, fromFile: string): Promise<void> {
  return assertHref(href, fromFile, localTargetExists);
}

/** HTML hrefs: must be a servable file (or a dir containing index.html). */
async function assertHtmlHref(href: string, fromFile: string): Promise<void> {
  return assertHref(href, fromFile, htmlTargetExists);
}

function extractHtmlHrefs(html: string): string[] {
  const targets: string[] = [];
  const re = /href="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    targets.push(match[1]!);
  }
  return targets;
}

function extractMarkdownDestinations(text: string): string[] {
  const targets: string[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    targets.push(match[2]!);
  }
  return targets;
}

export async function check(): Promise<void> {
  const html = await readFile(srcHtml, "utf8");
  const readme = await readFile(readmeMd, "utf8");

  const jobs: Promise<void>[] = [
    ...extractHtmlHrefs(html).map((href) => assertHtmlHref(href, srcHtml)),
    ...extractMarkdownDestinations(readme).map((href) =>
      assertReadmeHref(href, readmeMd),
    ),
  ];
  const results = await Promise.allSettled(jobs);
  const failures = results.flatMap((r) =>
    r.status === "rejected"
      ? [r.reason instanceof Error ? r.reason.message : String(r.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(`dead links:\n${failures.join("\n")}`);
  }

  console.log("docs links OK (docs/site/index.html + README.md)");
}

if (import.meta.main) {
  await check();
}
