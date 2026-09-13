import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check,
  defaultCheckPaths,
  extractHtmlHrefs,
  extractMarkdownDestinations,
} from "./check.ts";
import { writeCorpusFixture } from "./test-fixture.ts";

describe("docs link extraction", () => {
  test("extracts markdown destinations including relative deploy paths", () => {
    const md = [
      "See [deploy](../deploy.md) and [adoption](adoption.md).",
      "External [Traefik](https://doc.traefik.io/traefik/).",
      "Anchor [here](#smoke-checklist).",
    ].join("\n");

    expect(extractMarkdownDestinations(md)).toEqual([
      "../deploy.md",
      "adoption.md",
      "https://doc.traefik.io/traefik/",
      "#smoke-checklist",
    ]);
  });

  test("extracts html hrefs", () => {
    const html = `<a href="../deploy.md">deploy</a><a href="#cli">CLI</a>`;
    expect(extractHtmlHrefs(html)).toEqual(["../deploy.md", "#cli"]);
  });
});

describe("defaultCheckPaths", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("covers the published corpus, not just the front door", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    const paths = await defaultCheckPaths(root);
    expect(paths.htmlFiles).toEqual([join(root, "docs/site/index.html")]);
    for (const rel of [
      "docs/adoption.md",
      "docs/adr/README.md",
      "docs/adr/0001-thing.md",
      "examples/adopting-repo/README.md",
      "templates/README.md",
    ]) {
      expect(paths.markdownFiles).toContain(join(root, rel));
    }
  });

  test("passes when the published corpus resolves", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await check(await defaultCheckPaths(root));
  });

  test("fails on a dead link in adoption.md", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "adoption.md"),
      "See [missing](../no-such-file.md).\n",
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead link/,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /adoption\.md/,
    );
  });
});

describe("static-host rule", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("rejects a bare directory link without index.html", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "page.md"), "See [sub](sub/).\n");
    await expect(
      check({ rootDir: root, htmlFiles: [], markdownFiles: [join(root, "page.md")] }),
    ).rejects.toThrow(/dead link/);
  });

  test("accepts a directory link served via index.html", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "index.html"), "<html></html>");
    await writeFile(join(root, "page.md"), "See [sub](sub/).\n");
    await check({
      rootDir: root,
      htmlFiles: [],
      markdownFiles: [join(root, "page.md")],
    });
  });
});
