import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSite,
  publishDirs,
  publishFiles,
  rootRedirectHtml,
  siteEntryPath,
} from "./assemble.ts";
import { check, defaultCheckPaths } from "./check.ts";
import { writeCorpusFixture } from "./test-fixture.ts";

describe("publish manifest", () => {
  test("includes adoption.md and the deep-link trees", () => {
    expect(publishFiles).toContain("docs/adoption.md");
    expect(publishDirs).toContain("templates");
    expect(publishDirs).toContain("examples/adopting-repo");
  });

  test("keeps ADRs out of the consumer surface", () => {
    expect(publishDirs).not.toContain("docs/adr");
    for (const entry of [...publishFiles, ...publishDirs]) {
      expect(entry.toLowerCase().split("/")).not.toContain("adr");
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

    // One manifest, no overlapping entries: every path published exactly once.
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
    expect(published.every((p) => !p.split("/").includes("adr"))).toBe(true);
    expect(await readFile(join(out, "index.html"), "utf8")).toBe(
      rootRedirectHtml(),
    );

    // The artifact — not the repo — is what the gate validates, and the
    // root redirect is part of the checked HTML set.
    const paths = await defaultCheckPaths(out);
    expect(paths.htmlFiles).toContain(join(out, "index.html"));
    await check(paths);
  });

  test("never publishes maintainer ADR files left in the repo", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-assemble-"));
    const repo = join(root, "repo");
    const out = join(root, "site");
    await writeCorpusFixture(repo);

    // Maintainer ADRs still exist in the repo; the manifest must not copy them.
    await mkdir(join(repo, "docs", "adr"), { recursive: true });
    await writeFile(join(repo, "docs", "adr", "README.md"), "# adrs\n");
    await writeFile(join(repo, "docs", "adr", "0001-thing.md"), "# one\n");

    const published = await assembleSite(repo, out);

    expect(published.every((p) => !p.split("/").includes("adr"))).toBe(true);
    await expect(stat(join(out, "docs", "adr", "README.md"))).rejects.toThrow();
    await check(await defaultCheckPaths(out));
  });

  test("replaces outDir instead of merging, so stale orphans cannot ship", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-assemble-"));
    const repo = join(root, "repo");
    const out = join(root, "site");
    await writeCorpusFixture(repo);

    // Pre-seed a dirty outDir: orphan files and a stale page the manifest
    // no longer publishes.
    await mkdir(join(out, "orphan"), { recursive: true });
    await writeFile(join(out, "orphan", "stale.md"), "# stale\n");
    await writeFile(join(out, "index.html"), "<html>stale</html>");

    const published = await assembleSite(repo, out);

    expect(published).not.toContain("orphan/stale.md");
    await expect(stat(join(out, "orphan", "stale.md"))).rejects.toThrow();
    expect(await readFile(join(out, "index.html"), "utf8")).toBe(
      rootRedirectHtml(),
    );
    // The on-disk tree is exactly the manifest: no orphans beside it.
    const onDisk = await defaultCheckPaths(out);
    const rel = (abs: string) => abs.slice(out.length + 1);
    expect(
      new Set([
        ...onDisk.htmlFiles.map(rel),
        ...onDisk.markdownFiles.map(rel),
      ]),
    ).toEqual(new Set(published.filter((p) => p.endsWith(".html") || p.endsWith(".md"))));
  });
});
