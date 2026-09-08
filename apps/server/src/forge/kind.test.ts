import { describe, expect, test } from "bun:test";
import { resolveForgeKind } from "./kind.ts";

describe("resolveForgeKind", () => {
  test("infers github.com", () => {
    expect(resolveForgeKind("https://github.com/acme/widgets")).toBe("github");
  });

  test("infers gitlab.com", () => {
    expect(resolveForgeKind("https://gitlab.com/acme/widgets")).toBe("gitlab");
  });

  test("host map selects forge for custom hosts", () => {
    expect(
      resolveForgeKind("https://git.example.com/acme/widgets", {
        hostMap: { "git.example.com": "gitlab" },
      }),
    ).toBe("gitlab");
  });

  test("unknown host without map fails closed", () => {
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
