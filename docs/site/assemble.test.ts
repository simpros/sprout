import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSite,
  docsPages,
  pageHtmlFile,
  publishDirs,
  publishFiles,
  renderDocsIndexHtml,
  renderLlmsTxt,
  repoRootDir,
  rootRedirectHtml,
  siteEntryPath,
} from "./assemble.ts";
import { check, checkPublishedSite, defaultCheckPaths } from "./check.ts";
import {
  isExternalHref,
  markdownToHtmlBody,
  renderMarkdownPage,
  slugHeading,
  splitHref,
} from "./markdown.ts";
import { isAdrPath } from "./adr-policy.ts";
import { writeCorpusFixture } from "./test-fixture.ts";

function pathCovers(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -"/**".length);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return pattern === file;
}

describe("publish manifest", () => {
  test("includes adoption.md and the deep-link trees", () => {
    expect(publishFiles).toContain("docs/adoption.md");
    expect(publishFiles).toContain("docs/herdr-integration.md");
    expect(publishDirs).toContain("templates");
    expect(publishDirs).toContain("examples/adopting-repo");
  });

  test("derives the docs page set from docsPages (single source)", () => {
    for (const { file } of docsPages) {
      expect(publishFiles).toContain(file);
    }
    const docsEntries = publishFiles.filter(
      (p) => p.startsWith("docs/") && p.endsWith(".md"),
    );
    expect(new Set(docsEntries)).toEqual(
      new Set(docsPages.map((p) => p.file)),
    );
    expect(publishFiles).toContain("docs/index.html");
    expect(publishFiles).toContain("llms.txt");
  });

  test("uses every title and description (no dead model fields)", () => {
    const indexText = renderDocsIndexHtml().replace(/<[^>]+>/g, "");
    const llms = renderLlmsTxt();
    for (const page of docsPages) {
      expect(indexText).toContain(page.title);
      expect(llms).toContain(page.title);
      expect(llms).toContain(page.description);
      if (!page.legacy) {
        expect(indexText).toContain(page.description);
      }
    }
  });

  test("keeps ADRs out of the consumer surface", () => {
    expect(publishDirs).not.toContain("docs/adr");
    for (const entry of [...publishFiles, ...publishDirs]) {
      expect(isAdrPath(entry)).toBe(false);
    }
  });

  test("root redirect has no leading whitespace and targets the entry", () => {
    const html = rootRedirectHtml();
    for (const line of html.split("\n")) {
      expect(line).not.toMatch(/^ /);
    }
    expect(html).toContain(`url=${siteEntryPath}`);
    expect(html).toContain(`href="${siteEntryPath}"`);
  });

  test("every publish entry retriggers the docs workflow", async () => {
    const text = await readFile(
      join(import.meta.dir, "../../.github/workflows/docs.yml"),
      "utf8",
    );
    const doc = Bun.YAML.parse(text) as {
      on: { push: { paths: string[] } };
    };
    const uncovered = [...publishFiles, ...publishDirs].filter(
      (file) => !doc.on.push.paths.some((pattern) => pathCovers(pattern, file)),
    );
    expect(uncovered).toEqual([]);
  });
});

describe("assembleSite", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("published tree is self-contained for the link checker", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-assemble-"));
    const repo = join(root, "repo");
    const out = join(root, "site");
    await writeCorpusFixture(repo);

    const published = await assembleSite(repo, out);

    expect(new Set(published).size).toBe(published.length);

    for (const rel of [
      "docs/adoption.md",
      "templates/README.md",
      "templates/preview.yml",
      "examples/adopting-repo/docker-entrypoint.sh",
      "examples/adopting-repo/.github/workflows/sprout.yml",
      "index.html",
    ]) {
      expect(published).toContain(rel);
      expect((await stat(join(out, rel))).isFile()).toBe(true);
    }
    expect(published.every((p) => !isAdrPath(p))).toBe(true);
    expect(await readFile(join(out, "index.html"), "utf8")).toBe(
      rootRedirectHtml(),
    );

    const paths = await defaultCheckPaths(out);
    expect(paths.files.map((f) => f.path)).toContain(join(out, "index.html"));
    await check(paths);
  });

  test("renders each docs page to HTML with .html links and heading ids", async () => {
    expect(markdownToHtmlBody("# Hi\n")).toContain('id="hi"');

    const pages = new Set(["docs/other.html"]);
    const rendered = renderMarkdownPage(
      "Hi",
      "# Hi\n\nSee [other](other.md) and [frag](other.md#hi).\n\nKeep [raw](../templates/README.md).\n",
      "docs/adopting-a-repo.md",
      pages,
    );
    expect(rendered).toContain('<a href="other.html">other</a>');
    expect(rendered).toContain('<a href="other.html#hi">frag</a>');
    expect(rendered).toContain('<a href="../templates/README.md">raw</a>');
    expect(rendered).toContain("<main>");

    root = await mkdtemp(join(tmpdir(), "sprout-docs-assemble-"));
    const repo = join(root, "repo");
    const out = join(root, "site");
    await writeCorpusFixture(repo);

    const published = await assembleSite(repo, out);

    for (const { file } of docsPages) {
      const htmlFile = pageHtmlFile(file);
      expect(published).toContain(file);
      expect(published).toContain(htmlFile);
      expect((await stat(join(out, htmlFile))).isFile()).toBe(true);
    }
    expect(published).toContain("llms.txt");
    expect(published).toContain("docs/index.html");
    const renderedIndex = await readFile(join(out, "docs/index.html"), "utf8");
    expect(renderedIndex).toBe(renderDocsIndexHtml());
    expect(renderedIndex).not.toMatch(/href="[^"]*\.md"/);
    expect(await readFile(join(out, "llms.txt"), "utf8")).toBe(renderLlmsTxt());
    const renderedPage = await readFile(join(out, "docs/adoption.html"), "utf8");
    expect(renderedPage).toContain("<main>");
    await check(await defaultCheckPaths(out));
  });

  test("never publishes maintainer ADR files left in the repo", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-assemble-"));
    const repo = join(root, "repo");
    const out = join(root, "site");
    await writeCorpusFixture(repo);

    await mkdir(join(repo, "docs", "adr"), { recursive: true });
    await writeFile(join(repo, "docs", "adr", "README.md"), "# adrs\n");
    await writeFile(join(repo, "docs", "adr", "0001-thing.md"), "# one\n");

    const published = await assembleSite(repo, out);

    expect(published.every((p) => !isAdrPath(p))).toBe(true);
    await expect(stat(join(out, "docs", "adr", "README.md"))).rejects.toThrow();
    await check(await defaultCheckPaths(out));
  });

  test("replaces outDir instead of merging, so stale orphans cannot ship", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-assemble-"));
    const repo = join(root, "repo");
    const out = join(root, "site");
    await writeCorpusFixture(repo);

    await mkdir(join(out, "orphan"), { recursive: true });
    await writeFile(join(out, "orphan", "stale.md"), "# stale\n");
    await writeFile(join(out, "index.html"), "<html>stale</html>");

    const published = await assembleSite(repo, out);

    expect(published).not.toContain("orphan/stale.md");
    await expect(stat(join(out, "orphan", "stale.md"))).rejects.toThrow();
    expect(await readFile(join(out, "index.html"), "utf8")).toBe(
      rootRedirectHtml(),
    );
    const onDisk = await defaultCheckPaths(out);
    const rel = (abs: string) => abs.slice(out.length + 1);
    expect(
      new Set(
        onDisk.files
          .filter((f) => f.kind === "html" || f.kind === "markdown")
          .map((f) => rel(f.path)),
      ),
    ).toEqual(new Set(published.filter((p) => p.endsWith(".html") || p.endsWith(".md"))));
  });
});

describe("real corpus", () => {
  test("checked-in llms.txt matches the generated index", async () => {
    expect(await readFile(join(repoRootDir, "llms.txt"), "utf8")).toBe(
      renderLlmsTxt(),
    );
  });

  test("wrapped bullets stay in their list item and emphasis renders", async () => {
    const herdr = await readFile(
      join(repoRootDir, "docs/herdr-integration.md"),
      "utf8",
    );
    const herdrHtml = markdownToHtmlBody(herdr);
    expect(herdrHtml).not.toMatch(/<\/ul>\s*<p>verdict/);
    expect(herdrHtml).toMatch(/<li>Round 1:[\s\S]*?verdict \+ short SHA/);

    const ci = await readFile(
      join(repoRootDir, "docs/ci-integration.md"),
      "utf8",
    );
    const ciHtml = markdownToHtmlBody(ci);
    expect(ciHtml).toContain("<em>now</em>");
    expect(ciHtml).toContain("<em>inside</em>");
  });

  test("assembled real site passes the full gate", async () => {
    await checkPublishedSite();
  }, 30_000);

  test("html view keeps the GitHub double-hyphen anchors", async () => {
    const deploy = await readFile(
      join(repoRootDir, "docs/operator-deploy.md"),
      "utf8",
    );
    expect(markdownToHtmlBody(deploy)).toContain('id="upgrade--redeploy"');
    const previews = await readFile(
      join(repoRootDir, "docs/previews.md"),
      "utf8",
    );
    expect(markdownToHtmlBody(previews)).toContain(
      'id="multi-image-previews-app--services"',
    );
  });
});
