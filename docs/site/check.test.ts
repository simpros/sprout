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
  test("includes operator deploy.md alongside site html and README", () => {
    const paths = defaultCheckPaths("/repo");
    expect(paths.markdownFiles).toContain("/repo/docs/deploy.md");
    expect(paths.markdownFiles).toContain("/repo/README.md");
    expect(paths.htmlFiles).toContain("/repo/docs/site/index.html");
  });
});

describe("check includes deploy.md", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("fails when deploy.md has a dead local link", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    const siteDir = join(root, "docs", "site");
    await mkdir(siteDir, { recursive: true });

    await writeFile(join(siteDir, "index.html"), "<html></html>");
    await writeFile(join(root, "README.md"), "# ok\n");
    await writeFile(
      join(root, "docs", "deploy.md"),
      "See [missing](../no-such-file.md).\n",
    );

    await expect(check(defaultCheckPaths(root))).rejects.toThrow(/dead link/);
    await expect(check(defaultCheckPaths(root))).rejects.toThrow(/deploy\.md/);
  });

  test("passes when deploy.md local links resolve", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    const siteDir = join(root, "docs", "site");
    await mkdir(siteDir, { recursive: true });
    await mkdir(join(root, "e2e"), { recursive: true });
    await mkdir(join(root, "deploy", "traefik"), { recursive: true });

    await writeFile(join(siteDir, "index.html"), "<html></html>");
    await writeFile(join(root, "README.md"), "# ok\n");
    await writeFile(join(root, "CONTEXT.md"), "# ctx\n");
    await writeFile(join(root, "e2e", "README.md"), "# e2e\n");
    await writeFile(join(root, "docs", "adoption.md"), "# adopt\n");
    await writeFile(
      join(root, "deploy", "traefik", "certificates-resolver.dns.yml"),
      "# yml\n",
    );
    await writeFile(
      join(root, "docs", "deploy.md"),
      [
        "See [e2e](../e2e/README.md), [adoption](adoption.md),",
        "[CONTEXT](../CONTEXT.md), and",
        "[resolver](../deploy/traefik/certificates-resolver.dns.yml).",
        "External [issue](https://github.com/simpros/sprout/issues/12).",
      ].join(" "),
    );

    await check(defaultCheckPaths(root));
  });
});
