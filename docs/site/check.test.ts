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
import { findAdrMention, isAdrHref, isAdrPath } from "./adr-policy.ts";
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

  test("covers the root redirect links", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(join(root, "index.html"), `<a href="docs/site/nope.html">x</a>`);
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead link/,
    );
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

describe("ADR exclusion (standing rule: never consumer docs)", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("isAdrPath matches adr segments only", () => {
    expect(isAdrPath("docs/adr/README.md")).toBe(true);
    expect(isAdrPath("docs/ADR/0001-x.md")).toBe(true);
    expect(isAdrPath("docs/adoption.md")).toBe(false);
    expect(isAdrPath("README.md")).toBe(false);
  });

  test("findAdrMention bans the word, with / as a word boundary", () => {
    expect(findAdrMention("See docs/adoption.md for details.")).toBeNull();
    expect(findAdrMention("Postal address: 123 Main St.")).toBeNull();
    expect(findAdrMention("see ADR 0007")).not.toBeNull();
    expect(findAdrMention("see ADR-0007")).not.toBeNull();
    expect(findAdrMention("our ADRs live elsewhere")).not.toBeNull();
    // `/` is a non-word char, so `\bADRs?\b` also fires on an `adr` path
    // segment in raw text. `isAdrHref` exists so the gate can still report
    // those as ADR links rather than bare mentions.
    expect(findAdrMention("[decisions](docs/adr/README.md)")).not.toBeNull();
    expect(findAdrMention('<a href="../adr/README.md">x</a>')).not.toBeNull();
  });

  test("isAdrHref flags artifact-relative ADR targets only", () => {
    expect(isAdrHref("docs/adr/README.md")).toBe(true);
    expect(isAdrHref("../adr/README.md")).toBe(true);
    expect(isAdrHref("docs/ADR/0001-x.md")).toBe(true);
    expect(isAdrHref("docs/adoption.md")).toBe(false);
    expect(isAdrHref("#adr")).toBe(false);
    expect(isAdrHref("mailto:someone@example.com")).toBe(false);
    expect(isAdrHref("https://example.com/docs/adr/x.md")).toBe(false);
  });

  test("fails closed when an ADR file lands in the tree", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    // Temporarily re-add the leak the manifest must exclude.
    await mkdir(join(root, "docs", "adr"), { recursive: true });
    await writeFile(join(root, "docs", "adr", "README.md"), "# adrs\n");
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(/ADR leak/);
  });

  test("fails closed on a non-page ADR file in the tree", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await mkdir(join(root, "docs", "adr"), { recursive: true });
    await writeFile(join(root, "docs", "adr", "notes.yml"), "# notes\n");
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(/ADR leak/);
  });

  test("fails closed on an ADR link in README", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "README.md"),
      "# r\n[adopt](docs/adoption.md) [decisions](docs/adr/README.md)\n",
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(/ADR leak/);
  });

  test("fails closed on an inline ADR mention in HTML", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "site", "index.html"),
      `<html><body><a href="../adoption.md">adopt</a><p>see ADR 0007</p></body></html>\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(/ADR leak/);
  });
});
