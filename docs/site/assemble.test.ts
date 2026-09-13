import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

    for (const rel of [
      "docs/adoption.md",
      "docs/adr/0001-thing.md",
      "templates/README.md",
      "templates/preview.yml",
      "examples/adopting-repo/docker-entrypoint.sh",
      "examples/adopting-repo/.github/workflows/sprout.yml",
      "index.html",
    ]) {
      expect(published).toContain(rel);
      expect((await stat(join(out, rel))).isFile()).toBe(true);
    }
    expect(await readFile(join(out, "index.html"), "utf8")).toBe(
      rootRedirectHtml(),
    );

    // The artifact — not the repo — is what the gate validates.
    await check(await defaultCheckPaths(out));
  });
});
