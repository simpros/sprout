import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSite,
  docsPages,
  listFilesRecursive,
  marketingPage,
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
  markdownToHtmlBody,
  documentToc,
  extractPromptText,
  promptFence,
  renderMarkdown,
  rewritePageLinks,
} from "./markdown.ts";
import { renderShell } from "./shell.ts";
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
    const sourceFile = "docs/adopting-a-repo.md";
    const { document, body } = renderMarkdown(
      "# Hi\n\nSee [other](other.md) and [frag](other.md#hi).\n\nKeep [raw](../templates/README.md).\n",
    );
    const rendered = renderShell({
      title: "Hi",
      description: "Hi",
      outputPath: "docs/adopting-a-repo.html",
      nav: [],
      toc: documentToc(document),
      bodyHtml: rewritePageLinks(body, sourceFile, pages),
    });
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
    // The page list links twins only; the shared footer may point at files
    // with no HTML twin (examples stay `.md` by the twin rule itself).
    const indexBody = renderedIndex.replace(
      /<footer id="docs">[\s\S]*?<\/footer>/,
      "",
    );
    expect(indexBody).not.toMatch(/href="[^"]*\.md"/);
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

describe("shared shell, code blocks, and prompt embedding", () => {
  let root: string | undefined;
  let out = "";

  function stylePayload(html: string): string {
    const match = /<style>([\s\S]*?)<\/style>/.exec(html);
    if (!match) throw new Error("page carries no inlined theme");
    return match[1]!;
  }

  function scriptPayload(html: string): string {
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!match) throw new Error("page carries no inlined script");
    return match[1]!;
  }

  function scriptCount(html: string): number {
    return (html.match(/<script[ >]/g) ?? []).length;
  }

  // Escaped `<code>` bodies in document order; escaping is deterministic so
  // byte comparison needs no decoding round-trip.
  function codeBodies(html: string): string[] {
    return [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(
      (m) => m[1]!,
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-shell-"));
    out = join(root, "site");
    await assembleSite(repoRootDir, out);
  }, 30_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("marketing, docs index, and docs pages inline the same theme and script", async () => {
    const theme = await readFile(join(repoRootDir, "docs/site/theme.css"), "utf8");
    const pages = [
      join(out, siteEntryPath),
      join(out, "docs/index.html"),
      join(out, "docs/getting-started.html"),
    ];
    const styles = new Set<string>();
    const scripts = new Set<string>();
    for (const page of pages) {
      const html = await readFile(page, "utf8");
      styles.add(stylePayload(html));
      scripts.add(scriptPayload(html));
      expect(scriptCount(html)).toBe(1);
      expect(html).not.toContain('<link rel="stylesheet"');
      expect(html).not.toMatch(/<script[^>]*src=/);
    }
    expect(styles.size).toBe(1);
    expect(scripts.size).toBe(1);
    // Single source: every page inlines the theme file (edge newlines are
    // the shell's join framing, not a second copy of the theme).
    expect([...styles][0]!.trim()).toBe(theme.trim());
    const script = [...scripts][0]!;
    expect(script).toContain("navigator.clipboard");
    expect(script).toContain("Copied");
    expect(script).not.toContain("http");
  });

  test("every page carries the shared header, nav, and footer", async () => {
    const pages = [
      join(out, siteEntryPath),
      join(out, "docs/index.html"),
      ...docsPages.map((p) => join(out, pageHtmlFile(p.file))),
    ];
    for (const page of pages) {
      const html = await readFile(page, "utf8");
      expect(html).toContain('<header class="site">');
      expect(html).toContain('<nav class="docs-nav" aria-label="Docs">');
      expect(html).toContain('<footer id="docs">');
      expect(html).toContain('<div class="codeblock-status" aria-live="polite">');
      // The shell owns `.wrap`: exactly one per page, never nested.
      expect(html.match(/<div class="wrap">/g) ?? []).toHaveLength(1);
      // The shell owns the brand mark: exactly one per page.
      expect(html.match(/class="brand"/g) ?? []).toHaveLength(1);
      for (const { title } of docsPages) {
        expect(html).toContain(`>${title}</a>`);
      }
    }
    const marketing = await readFile(join(out, siteEntryPath), "utf8");
    expect(marketing).toContain('<header class="hero">');
  });

  test("every fenced block renders as the component; no bare pre remains", async () => {
    const absFiles = await listFilesRecursive(out);
    const htmlFiles = absFiles.filter((f) => f.endsWith(".html"));
    expect(htmlFiles.length).toBeGreaterThan(docsPages.length);
    let figures = 0;
    for (const file of htmlFiles) {
      const html = await readFile(file, "utf8");
      const withoutScript = html.replace(/<script>[\s\S]*?<\/script>/, "");
      for (const figure of withoutScript.matchAll(
        /<figure class="codeblock" data-lang="([^"]+)">([\s\S]*?)<\/figure>/g,
      )) {
        figures += 1;
        const lang = figure[1]!;
        const inner = figure[2]!;
        expect(inner).toContain(`<span class="codeblock-lang">${lang}</span>`);
        expect(inner).toContain(
          '<button class="codeblock-copy" type="button"',
        );
        expect(inner).toMatch(/<pre><code>[\s\S]*<\/code><\/pre>/);
      }
      const withoutFigures = withoutScript.replace(
        /<figure class="codeblock"[\s\S]*?<\/figure>/g,
        "",
      );
      expect(withoutFigures).not.toContain("<pre");
    }
    expect(figures).toBeGreaterThan(20);
  });

  test("the prompt is single-sourced and byte-identical on three surfaces", async () => {
    const prompt = extractPromptText(
      await readFile(join(repoRootDir, "docs/onboarding-prompt.md"), "utf8"),
    );
    // Sources carry the marker, never the prompt text itself.
    for (const source of ["docs/getting-started.md", "docs/site/index.html"]) {
      const text = await readFile(join(repoRootDir, source), "utf8");
      expect(text).toContain("<!-- docs-onboarding-prompt -->");
      expect(text).not.toContain("You are onboarding this repository");
    }
    const promptCode = (html: string): string => {
      const bodies = codeBodies(html).filter((b) =>
        b.startsWith("You are onboarding"),
      );
      expect(bodies.length).toBe(1);
      return bodies[0]!;
    };
    const gettingStarted = await readFile(
      join(out, "docs/getting-started.html"),
      "utf8",
    );
    const marketing = await readFile(join(out, siteEntryPath), "utf8");
    const promptPage = await readFile(
      join(out, "docs/onboarding-prompt.html"),
      "utf8",
    );
    expect(promptCode(gettingStarted)).toBe(promptCode(marketing));
    expect(promptCode(marketing)).toBe(promptCode(promptPage));
    const assembledMd = await readFile(
      join(out, "docs/getting-started.md"),
      "utf8",
    );
    expect(assembledMd).toContain(promptFence(prompt));
    // The fence meta round-trips the onboarding copy label, so the embedded
    // prompt and its canonical page share one accessible name.
    for (const html of [gettingStarted, marketing, promptPage]) {
      expect(html).toContain('aria-label="Copy onboarding prompt"');
    }
  });

  test("the link gate fails an unresolved prompt marker", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "sprout-docs-marker-"));
    try {
      const repo = join(tmp, "repo");
      const site = join(tmp, "site");
      await writeCorpusFixture(repo);
      await assembleSite(repo, site);

      const victim = join(site, "docs/getting-started.md");
      const text = await readFile(victim, "utf8");
      await writeFile(victim, `${text}<!-- docs-onboarding-prompt -->\n`);
      await expect(check(await defaultCheckPaths(site))).rejects.toThrow(
        "unresolved prompt marker",
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("marketing page is rendered, not copied verbatim", async () => {
    const source = await readFile(join(repoRootDir, siteEntryPath), "utf8");
    const html = await readFile(join(out, siteEntryPath), "utf8");
    // The source is a body fragment: no envelope, no wrap —
    // the shell inlines the theme and owns `.wrap` for every page.
    expect(source).not.toContain("<!DOCTYPE html>");
    expect(source).not.toContain("<html");
    expect(source).not.toContain("<head>");
    expect(source).not.toContain("<body>");
    expect(source).not.toContain('<div class="wrap">');
    expect(source).toContain("<!-- docs-onboarding-prompt -->");
    // Title and description come from the manifest, not source regexes.
    expect(html).toContain(`<title>${marketingPage.title}</title>`);
    expect(html).toContain(
      `<meta name="description" content="${marketingPage.description}" />`,
    );
    expect(html).not.toBe(source);
    expect(html).not.toContain("<!-- docs-onboarding-prompt -->");
    expect(html).toContain('<figure class="codeblock"');
  });

  test("every TOC href resolves to an id on its own page", async () => {
    const html = await readFile(join(out, "docs/getting-started.html"), "utf8");
    const toc = /<nav class="toc-page"[\s\S]*?<\/nav>/.exec(html)?.[0];
    expect(toc).toBeDefined();
    const hrefs = [...toc!.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) {
      expect(html).toContain(`id="${href}"`);
    }
  });
});
