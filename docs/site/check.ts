/**
 * Link checker for the published docs site.
 *
 * The checked tree is the Pages artifact, not the repo: `checkPublishedSite`
 * assembles the publish set (see assemble.ts) into a temp dir and validates
 * every published HTML/markdown page there. Green docs:check therefore means
 * the Pages URLs resolve.
 *
 * Pages is a static file host: a link target must be a file (a directory
 * only counts when it carries its own index.html — Pages serves that, but
 * never a generated listing). This intentionally differs from GitHub's UI,
 * which renders bare directory links.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleSite,
  listPublishedMarkdown,
  repoRootDir,
  siteEntryPath,
} from "./assemble.ts";

const siteDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(siteDir, "../..");

export type CheckPaths = {
  rootDir: string;
  htmlFiles: string[];
  markdownFiles: string[];
};

export async function defaultCheckPaths(
  rootDir = defaultRootDir,
): Promise<CheckPaths> {
  return {
    rootDir,
    htmlFiles: [join(rootDir, siteEntryPath)],
    markdownFiles: await listPublishedMarkdown(rootDir),
  };
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

export async function check(paths: CheckPaths): Promise<void> {
  // Attach handlers at push time: without this, a fast-rejecting link
  // check would sit unhandled while later readFile awaits run, and Bun
  // reports it as an unhandled rejection before allSettled attaches.
  const jobs: Promise<string | null>[] = [];
  const track = (job: Promise<void>): void => {
    jobs.push(
      job.then(
        () => null,
        (reason) => (reason instanceof Error ? reason.message : String(reason)),
      ),
    );
  };

  for (const htmlFile of paths.htmlFiles) {
    const html = await readFile(htmlFile, "utf8");
    for (const href of extractHtmlHrefs(html)) {
      track(assertHref(href, htmlFile, siteTargetExists));
    }
  }

  for (const mdFile of paths.markdownFiles) {
    const text = await readFile(mdFile, "utf8");
    for (const href of extractMarkdownDestinations(text)) {
      track(assertHref(href, mdFile, siteTargetExists));
    }
  }

  const failures = (await Promise.all(jobs)).filter((f) => f !== null);
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
  await checkPublishedSite();
}
