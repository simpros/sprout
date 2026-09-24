import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSite,
  SITE_ORIGIN,
} from "./assemble.ts";
import {
  check,
  defaultCheckPaths,
  extractBareSiteUrls,
  extractHrefs,
  extractHtmlTargets,
  extractMarkdownDestinations,
} from "./check.ts";
import { isExternalHref } from "./markdown.ts";
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

  test("extracts html targets from href and src", () => {
    const html = `<a href="../deploy.md">deploy</a><a href="#cli">CLI</a><img src="../assets/sprout-mark.png" alt="" />`;
    expect(extractHtmlTargets(html)).toEqual([
      "../deploy.md",
      "#cli",
      "../assets/sprout-mark.png",
    ]);
  });

  test("inline data payloads are external; relative targets are not", () => {
    expect(isExternalHref("data:image/svg+xml,%3Csvg/%3E")).toBe(true);
    expect(isExternalHref("https://example.com/x.png")).toBe(true);
    expect(isExternalHref("mailto:someone@example.com")).toBe(true);
    expect(isExternalHref("../assets/sprout-mark.png")).toBe(false);
    expect(isExternalHref("assets/sprout-mark.png")).toBe(false);
    expect(isExternalHref("#cli")).toBe(false);
  });

  test("extracts embedded html targets from markdown sources", () => {
    const md = `<p align="center">\n  <img src="assets/sprout-mark.png" width="132" alt="sprout">\n</p>\n`;
    expect(extractHrefs(md, "markdown")).toContain("assets/sprout-mark.png");
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
    const rel = (kind: string) =>
      paths.files.filter((f) => f.kind === kind).map((f) => f.path);
    expect(rel("html")).toContain(join(root, "docs/site/index.html"));
    expect(rel("html")).toContain(join(root, "docs/index.html"));
    expect(rel("text")).toContain(join(root, "llms.txt"));
    for (const relPath of [
      "docs/herdr-integration.md",
      "docs/getting-started.md",
      "docs/adopting-a-repo.md",
      "docs/ci-integration.md",
      "docs/operator-deploy.md",
      "docs/previews.md",
      "docs/cli-reference.md",
      "docs/troubleshooting.md",
      "docs/onboarding-prompt.md",
      "examples/adopting-repo/README.md",
      "templates/README.md",
    ]) {
      expect(rel("markdown")).toContain(join(root, relPath));
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

  test("fails on a dead image src", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "index.html"),
      `<html><body><img src="../assets/no-such-mark.png" alt="" /></body></html>\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead link/,
    );
  });

  test("fails on a dead image src embedded in markdown", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "README.md"),
      `# r\n<img src="assets/no-such-mark.png" width="132" alt="sprout">\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead link/,
    );
  });

  test("passes an inline data-uri image src", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "index.html"),
      `<html><body><img src="data:image/svg+xml,%3Csvg/%3E" alt="" /></body></html>\n`,
    );
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

  test("fails on a dead link in llms.txt", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "llms.txt"),
      `Start.\n- [Missing](${SITE_ORIGIN}/docs/no-such-page.md): gone.\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead link/,
    );
  });

  test("resolves absolute index links against the checked tree", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    const llms = await readFile(join(root, "llms.txt"), "utf8");
    expect(llms).toContain(SITE_ORIGIN);
    await check(await defaultCheckPaths(root));
  });
});

describe("fragment resolution", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("accepts a markdown fragment whose heading exists", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(join(root, "docs", "deploy.md"), "# Deploy\n");
    await writeFile(
      join(root, "docs", "adoption.md"),
      "See [deploy](deploy.md#deploy).\n",
    );
    await check(await defaultCheckPaths(root));
  });

  test("rejects a markdown fragment whose heading is missing", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(join(root, "docs", "deploy.md"), "# Deploy\n");
    await writeFile(
      join(root, "docs", "adoption.md"),
      "See [deploy](deploy.md#no-such-heading).\n",
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead fragment/,
    );
  });

  test("fragments speak GitHub anchors, not the collapsed form", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(join(root, "docs", "deploy.md"), "## Upgrade / redeploy\n");
    await writeFile(
      join(root, "docs", "adoption.md"),
      "See [u](deploy.md#upgrade--redeploy).\n",
    );
    await check(await defaultCheckPaths(root));
    await writeFile(
      join(root, "docs", "adoption.md"),
      "See [u](deploy.md#upgrade-redeploy).\n",
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead fragment/,
    );
  });

  test("rejects an html fragment whose id is missing", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "index.html"),
      `<html><body><a href="getting-started.md">start</a><a href="#no-such-id">x</a></body></html>\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead fragment/,
    );
  });

  test("accepts a same-page anchor whose id exists", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "index.html"),
      `<html><body><h2 id="cli">CLI</h2><a href="#cli">x</a></body></html>\n`,
    );
    await check(await defaultCheckPaths(root));
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
      check({ rootDir: root, files: [{ path: join(root, "page.md"), kind: "markdown" }] }),
    ).rejects.toThrow(/dead link/);
  });

  test("accepts a directory link served via index.html", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "index.html"), "<html></html>");
    await writeFile(join(root, "page.md"), "See [sub](sub/).\n");
    await check({
      rootDir: root,
      files: [{ path: join(root, "page.md"), kind: "markdown" }],
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

  test("findAdrMention bans the word, not adr path segments", () => {
    expect(findAdrMention("See docs/adoption.md for details.")).toBeNull();
    expect(findAdrMention("Postal address: 123 Main St.")).toBeNull();
    expect(findAdrMention("see ADR 0007")).not.toBeNull();
    expect(findAdrMention("see ADR-0007")).not.toBeNull();
    expect(findAdrMention("our ADRs live elsewhere")).not.toBeNull();
    // `/` belongs to path tokens, so raw `adr/` segments report via `isAdrHref`/`isAdrPath`.
    expect(findAdrMention("[decisions](docs/adr/README.md)")).toBeNull();
    expect(findAdrMention('<a href="../adr/README.md">x</a>')).toBeNull();
  });

  test("isAdrHref flags artifact-relative ADR targets only", () => {
    expect(isAdrHref("docs/adr/README.md")).toBe(true);
    expect(isAdrHref("../adr/README.md")).toBe(true);
    expect(isAdrHref("docs/ADR/0001-x.md")).toBe(true);
    expect(isAdrHref("docs/adoption.md")).toBe(false);
    expect(isAdrHref("#adr")).toBe(false);
    expect(isAdrHref("mailto:someone@example.com")).toBe(false);
    expect(isAdrHref("https://example.com/docs/adr/x.md")).toBe(false);
    expect(isAdrHref("//cdn.example/docs/adr/x.md")).toBe(false);
  });

  test("fails closed when an ADR file lands in the tree", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
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
      "# r\n[start](docs/getting-started.md) [decisions](docs/adr/README.md)\n",
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(/ADR leak/);
  });

  test("fails closed on an inline ADR mention in HTML", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "site", "index.html"),
      `<html><body><a href="../getting-started.md">start</a><p>see ADR 0007</p></body></html>\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(/ADR leak/);
  });
});

describe("agent-first index", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("every llms.txt entry resolves in the assembled tree", async () => {
    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    const out = join(root, "site");
    await assembleSite(root, out);
    const llms = await readFile(join(out, "llms.txt"), "utf8");
    const urls = extractMarkdownDestinations(llms).filter((u) =>
      u.startsWith(`${SITE_ORIGIN}/`),
    );
    expect(urls.length).toBeGreaterThan(5);
    expect(llms).toMatch(/onboarding/i);
    for (const url of urls) {
      const rel = url.replace(`${SITE_ORIGIN}/`, "");
      expect((await stat(join(out, rel))).isFile()).toBe(true);
    }
    await check(await defaultCheckPaths(out));
  });

  test("bare same-site URLs are gated, placeholders are not", async () => {
    expect(
      extractBareSiteUrls(`1. ${SITE_ORIGIN}/llms.txt — the index.\n`),
    ).toEqual([`${SITE_ORIGIN}/llms.txt`]);
    expect(extractBareSiteUrls("See https://example.com/x.\n")).toEqual([]);

    root = await mkdtemp(join(tmpdir(), "sprout-docs-check-"));
    await writeCorpusFixture(root);
    await writeFile(
      join(root, "docs", "onboarding-prompt.md"),
      `Start here: ${SITE_ORIGIN}/docs/no-such-page.md\n`,
    );
    await expect(check(await defaultCheckPaths(root))).rejects.toThrow(
      /dead link/,
    );
  });
});
