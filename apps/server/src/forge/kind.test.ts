import { describe, expect, test } from "bun:test";
import { resolveForgeKind } from "./kind.ts";

describe("resolveForgeKind", () => {
  test("infers github.com", () => {
    expect(resolveForgeKind("https://github.com/acme/widgets")).toBe("github");
  });

  test("infers www.github.com", () => {
    expect(resolveForgeKind("https://www.github.com/acme/widgets")).toBe(
      "github",
    );
  });

  test("infers gitlab.com", () => {
    expect(resolveForgeKind("https://gitlab.com/acme/widgets")).toBe("gitlab");
  });

  test("extra hosts select GitLab for self-managed hosts", () => {
    expect(
      resolveForgeKind("https://git.example.com/acme/widgets", {
        extraGitlabHosts: new Set(["git.example.com"]),
      }),
    ).toBe("gitlab");
  });

  test("extra hosts cannot remap github.com (github wins)", () => {
    expect(
      resolveForgeKind("https://github.com/acme/widgets", {
        extraGitlabHosts: new Set(["github.com"]),
      }),
    ).toBe("github");
  });

  test("unknown host without extras fails closed", () => {
    try {
      resolveForgeKind("https://git.example.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(String(error)).toContain("Cannot infer forge");
      expect(String(error)).toContain("SPROUT_FORGE_HOSTS");
    }
  });

  test("invalid URL fails closed", () => {
    try {
      resolveForgeKind("not-a-url");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(String(error)).toContain("Invalid canonical repo id");
    }
  });
});
