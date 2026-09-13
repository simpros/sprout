/**
 * Build the public docs site: validate source HTML, check relative links,
 * and publish a copy under docs/site/dist/ for local preview.
 */
import { mkdir, readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(siteDir, "../..");
const srcHtml = join(siteDir, "index.html");
const distDir = join(siteDir, "dist");
const distHtml = join(distDir, "index.html");

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function extractHrefTargets(html: string): string[] {
  const targets: string[] = [];
  const re = /href="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    targets.push(match[1]!);
  }
  return targets;
}

async function assertLocalTarget(
  href: string,
  fromFile: string,
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
  const ok =
    (await pathExists(resolved)) || (await isDirectory(resolved));
  if (!ok) {
    throw new Error(`dead link in ${fromFile}: ${href} → ${resolved}`);
  }
}

async function checkReadmeLinks(): Promise<void> {
  const readme = join(rootDir, "README.md");
  const text = await readFile(readme, "utf8");
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const href = match[2]!;
    if (
      href.startsWith("http://") ||
      href.startsWith("https://") ||
      href.startsWith("#")
    ) {
      continue;
    }
    const [pathPart] = href.split("#");
    if (!pathPart) continue;
    const resolved = resolve(rootDir, pathPart);
    const ok =
      (await pathExists(resolved)) || (await isDirectory(resolved));
    if (!ok) {
      throw new Error(`dead link in README.md: ${href} → ${resolved}`);
    }
  }
}

async function main(): Promise<void> {
  const html = await readFile(srcHtml, "utf8");
  if (!html.includes("<title>") || !html.includes("sprout")) {
    throw new Error("docs/site/index.html looks incomplete");
  }

  for (const href of extractHrefTargets(html)) {
    await assertLocalTarget(href, srcHtml);
  }
  await checkReadmeLinks();

  await mkdir(distDir, { recursive: true });
  await copyFile(srcHtml, distHtml);
  await writeFile(
    join(distDir, ".build-stamp"),
    `${new Date().toISOString()}\n`,
  );

  console.log(`docs site built → ${distHtml}`);
}

await main();
