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

async function assertLocalHref(href: string, fromFile: string): Promise<void> {
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
  if (!(await localTargetExists(resolved))) {
    throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
  }
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
  if (!html.includes("<title>") || !html.includes("sprout")) {
    throw new Error("docs/site/index.html looks incomplete");
  }
  const readme = await readFile(readmeMd, "utf8");

  const jobs: Promise<void>[] = [
    ...extractHtmlHrefs(html).map((href) => assertLocalHref(href, srcHtml)),
    ...extractMarkdownDestinations(readme).map((href) =>
      assertLocalHref(href, readmeMd),
    ),
  ];
  const results = await Promise.allSettled(jobs);
  const failures = results.flatMap((r) =>
    r.status === "rejected" ? [(r.reason as Error).message] : [],
  );
  if (failures.length > 0) {
    throw new Error(`dead links:\n${failures.join("\n")}`);
  }

  console.log("docs links OK (docs/site/index.html + README.md)");
}

if (import.meta.main) {
  await check();
}
