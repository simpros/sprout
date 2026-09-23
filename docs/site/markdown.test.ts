import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  extractPromptText,
  isExternalHref,
  markdownToHtmlBody,
  slugHeading,
  splitHref,
} from "./markdown.ts";
import { repoRootDir } from "./assemble.ts";

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

describe("extractPromptText", () => {
  test("reads the meta-tagged fence from the AST", async () => {
    const source = await readFile(
      join(repoRootDir, "docs/onboarding-prompt.md"),
      "utf8",
    );
    const prompt = extractPromptText(source);
    expect(prompt.startsWith("You are onboarding this repository")).toBe(true);
    expect(prompt).not.toContain("```");
  });

  test("ignores untagged fences and fails loudly on inner fences", () => {
    expect(
      extractPromptText(
        '```yaml\nk: v\n```\n\n```text prompt\n abilities\n```\n',
      ),
    ).toBe("abilities");
    expect(() => extractPromptText("# no fence here\n")).toThrow();
    expect(() =>
      extractPromptText("```text prompt\na\n```inner\nb\n```\n"),
    ).toThrow();
  });
});
