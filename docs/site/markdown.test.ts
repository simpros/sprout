import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  BlockNode,
  InlineNode,
  MarkdownDocument,
} from "@tanstack/markdown";
import {
  documentToc,
  isExternalHref,
  markdownToHtmlBody,
  parseMarkdownDocument,
  slugHeading,
  splitHref,
} from "./markdown.ts";
import { decodeHtmlEntities } from "./html.ts";
import { docsPages, repoRootDir } from "./assemble.ts";

describe("slugHeading (GitHub anchor dialect)", () => {
  test("keeps double hyphens where punctuation sat between spaces", () => {
    expect(slugHeading("Component → CLI ownership")).toBe(
      "component--cli-ownership",
    );
    expect(slugHeading("Multi-image previews (app + services)")).toBe(
      "multi-image-previews-app--services",
    );
    expect(slugHeading("Upgrade / redeploy")).toBe("upgrade--redeploy");
    expect(slugHeading("Bun / Node one-liner variant")).toBe(
      "bun--node-one-liner-variant",
    );
    expect(
      slugHeading("Production-shaped deploy (external / Coolify Traefik)"),
    ).toBe("production-shaped-deploy-external--coolify-traefik");
    expect(
      slugHeading("Prerequisites (secrets / access — not in this repo)"),
    ).toBe("prerequisites-secrets--access--not-in-this-repo");
  });

  test("drops code ticks, dots, and slashes without doubling", () => {
    expect(slugHeading("Manifest keys (`.sprout.yaml`)")).toBe(
      "manifest-keys-sproutyaml",
    );
    expect(slugHeading("Component inputs (`templates/preview.yml`)")).toBe(
      "component-inputs-templatespreviewyml",
    );
  });

  test("keeps underscores, lowercases", () => {
    expect(slugHeading("SPROUT_PREVIEW_POSTGRES_URL")).toBe(
      "sprout_preview_postgres_url",
    );
  });
});

describe("markdownToHtmlBody heading ids", () => {
  test("emits GitHub slugs, not the runtime's collapsed form", () => {
    expect(markdownToHtmlBody("## Component → CLI ownership\n")).toContain(
      'id="component--cli-ownership"',
    );
    expect(
      markdownToHtmlBody("## Multi-image previews (app + services)\n"),
    ).toContain('id="multi-image-previews-app--services"');
    expect(markdownToHtmlBody("## Upgrade / redeploy\n")).toContain(
      'id="upgrade--redeploy"',
    );
  });

  test("dedupes repeat headings GitHub-style", () => {
    const html = markdownToHtmlBody("## See also\n\n## See also\n");
    expect(html).toContain('id="see-also"');
    expect(html).toContain('id="see-also-1"');
  });
});

describe("shared href helpers", () => {
  test("splitHref separates path, suffix, and fragment", () => {
    expect(splitHref("other.md#hi")).toEqual({
      path: "other.md",
      suffix: "#hi",
      fragment: "hi",
    });
    expect(splitHref("other.md?a=b#hi")).toEqual({
      path: "other.md",
      suffix: "?a=b#hi",
      fragment: "hi",
    });
    expect(splitHref("#hi")).toEqual({ path: "", suffix: "#hi", fragment: "hi" });
    expect(splitHref("other.md")).toEqual({
      path: "other.md",
      suffix: "",
      fragment: null,
    });
  });

  test("isExternalHref leaves same-page anchors to the gate", () => {
    expect(isExternalHref("https://example.com/x")).toBe(true);
    expect(isExternalHref("//cdn.example/x")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(true);
    expect(isExternalHref("#cli")).toBe(false);
    expect(isExternalHref("other.md#hi")).toBe(false);
  });
});

describe("docs toolchain pins", () => {
  test("TanStack Markdown is exactly pinned, never the React entry", async () => {
    const pkg = JSON.parse(
      await readFile(join(repoRootDir, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@tanstack/markdown"]).toBe("0.0.13");
    for (const entry of await readdir(import.meta.dir)) {
      if (!entry.endsWith(".ts")) continue;
      const text = await readFile(join(import.meta.dir, entry), "utf8");
      // Joined so this assertion cannot match its own source.
      expect(text).not.toContain(
        ["@tanstack/markdown", "react"].join("/"),
      );
    }
  });
});

// The previous pipeline, reachable in the test only: the runtime's built-in
// GFM renderer with heading ids retitled to the GitHub anchor dialect.
function legacyHtmlBody(markdown: string): string {
  const seen = new Map<string, number>();
  const html = Bun.markdown.html(markdown, { headings: true });
  return html.replace(
    /<h([1-6]) id="([^"]*)">([\s\S]*?)<\/h\1>/g,
    (whole, _level: string, oldId: string, inner: string) => {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ""));
      let slug = slugHeading(text);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count}`;
      return whole
        .replace(`id="${oldId}"`, `id="${slug}"`)
        .replace(`href="#${oldId}"`, `href="#${slug}"`);
    },
  );
}

function legacyHeadingIds(html: string): string[] {
  return [...html.matchAll(/<h[1-6] id="([^"]+)">/g)].map((m) => m[1]!);
}

function legacyCodeBlocks(html: string): { lang: string; value: string }[] {
  return [
    ...html.matchAll(
      /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    ),
  ].map((m) => ({
    lang: m[1] ?? "text",
    value: decodeHtmlEntities(m[2]!).replace(/\n$/, ""),
  }));
}

function legacyTableShapes(html: string): { rows: number; cells: number }[] {
  return [...html.matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => ({
    rows: (m[0].match(/<tr>/g) ?? []).length,
    cells: (m[0].match(/<(?:th|td)>/g) ?? []).length,
  }));
}

function legacyHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

function walkInlines(
  nodes: InlineNode[],
  visit: (node: InlineNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if ("children" in node && Array.isArray(node.children)) {
      walkInlines(node.children as InlineNode[], visit);
    }
  }
}

function collectContentHrefs(nodes: BlockNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === "heading" || node.type === "paragraph") {
      walkInlines(node.children, (inline) => {
        if (inline.type === "link") out.push(inline.href);
      });
    } else if (node.type === "list") {
      for (const item of node.items) collectContentHrefs(item.children, out);
    } else if (node.type === "blockquote" || node.type === "callout") {
      collectContentHrefs(node.children, out);
    } else if (node.type === "table") {
      for (const cell of [...node.header, ...node.rows.flat()]) {
        walkInlines(cell.children, (inline) => {
          if (inline.type === "link") out.push(inline.href);
        });
      }
    }
  }
}

function documentCodeBlocks(
  document: MarkdownDocument,
): { lang: string; value: string }[] {
  const out: { lang: string; value: string }[] = [];
  const visit = (nodes: BlockNode[]): void => {
    for (const node of nodes) {
      if (node.type === "code") {
        out.push({ lang: node.lang ?? "text", value: node.value });
      } else if (node.type === "list") {
        for (const item of node.items) visit(item.children);
      } else if (node.type === "blockquote" || node.type === "callout") {
        visit(node.children);
      }
    }
  };
  visit(document.children);
  return out;
}

function documentTableShapes(
  document: MarkdownDocument,
): { rows: number; cells: number }[] {
  const out: { rows: number; cells: number }[] = [];
  const visit = (nodes: BlockNode[]): void => {
    for (const node of nodes) {
      if (node.type === "table") {
        out.push({
          rows: 1 + node.rows.length,
          cells:
            node.header.length +
            node.rows.reduce((sum, row) => sum + row.length, 0),
        });
      } else if (node.type === "list") {
        for (const item of node.items) visit(item.children);
      } else if (node.type === "blockquote" || node.type === "callout") {
        visit(node.children);
      }
    }
  };
  visit(document.children);
  return out;
}

function documentHrefs(document: MarkdownDocument): string[] {
  const out: string[] = [];
  collectContentHrefs(document.children, out);
  // Rendered heading self-anchors carry the same hrefs on both sides.
  for (const heading of documentToc(document)) out.push(`#${heading.id}`);
  return out.sort();
}

// Deliberate renderer differences, named with their reason. Empty means the
// corpus renders identically across every compared dimension; an entry that
// stops matching fails the suite so allowlisting can never go stale.
const PARITY_ALLOWLIST: Record<string, { dimension: string; reason: string }[]> =
  {};

describe("renderer parity over the whole corpus", () => {
  for (const { file } of docsPages) {
    test(`${file} survives the renderer swap`, async () => {
      const markdown = await readFile(join(repoRootDir, file), "utf8");
      const legacy = legacyHtmlBody(markdown);
      const document = parseMarkdownDocument(markdown);
      const failures: string[] = [];
      const allow = (dimension: string, detail: string): void => {
        const entries = PARITY_ALLOWLIST[file] ?? [];
        const hit = entries.find((e) => e.dimension === dimension);
        if (!hit) failures.push(`${dimension}: ${detail}`);
      };

      const legacyIds = legacyHeadingIds(legacy);
      const nextIds = documentToc(document).map((h) => h.id);
      if (JSON.stringify(legacyIds) !== JSON.stringify(nextIds)) {
        allow(
          "heading-ids",
          `legacy ${JSON.stringify(legacyIds)} vs next ${JSON.stringify(nextIds)}`,
        );
      }

      const legacyCode = legacyCodeBlocks(legacy);
      const nextCode = documentCodeBlocks(document);
      if (JSON.stringify(legacyCode) !== JSON.stringify(nextCode)) {
        allow(
          "code-blocks",
          `legacy ${JSON.stringify(legacyCode)} vs next ${JSON.stringify(nextCode)}`,
        );
      }

      const legacyTables = legacyTableShapes(legacy);
      const nextTables = documentTableShapes(document);
      if (JSON.stringify(legacyTables) !== JSON.stringify(nextTables)) {
        allow(
          "tables",
          `legacy ${JSON.stringify(legacyTables)} vs next ${JSON.stringify(nextTables)}`,
        );
      }

      const legacyLinks = legacyHrefs(legacy).sort();
      const nextLinks = documentHrefs(document);
      if (JSON.stringify(legacyLinks) !== JSON.stringify(nextLinks)) {
        allow(
          "links",
          `legacy ${JSON.stringify(legacyLinks)} vs next ${JSON.stringify(nextLinks)}`,
        );
      }

      expect(failures).toEqual([]);
    });
  }

  test("every allowlist entry is still load-bearing", async () => {
    const used = new Set<string>();
    for (const { file } of docsPages) {
      const markdown = await readFile(join(repoRootDir, file), "utf8");
      const legacy = legacyHtmlBody(markdown);
      const document = parseMarkdownDocument(markdown);
      const dims: Record<string, [unknown, unknown]> = {
        "heading-ids": [
          legacyHeadingIds(legacy),
          documentToc(document).map((h) => h.id),
        ],
        "code-blocks": [legacyCodeBlocks(legacy), documentCodeBlocks(document)],
        tables: [legacyTableShapes(legacy), documentTableShapes(document)],
        links: [legacyHrefs(legacy).sort(), documentHrefs(document)],
      };
      for (const [dimension, [a, b]] of Object.entries(dims)) {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          used.add(`${file} ${dimension}`);
        }
      }
    }
    const listed = Object.entries(PARITY_ALLOWLIST).flatMap(([file, entries]) =>
      entries.map((e) => `${file} ${e.dimension}`),
    );
    expect(listed.sort()).toEqual([...used].sort());
  });
});
