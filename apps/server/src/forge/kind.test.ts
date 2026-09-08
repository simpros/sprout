import { describe, expect, test } from "bun:test";
import { isForgeApiError } from "./types.ts";
import { resolveForgeKind } from "./kind.ts";

describe("resolveForgeKind", () => {
  test("infers github from github.com canonical repo id", () => {
    expect(resolveForgeKind("https://github.com/acme/widgets")).toBe("github");
  });

  test("infers gitlab from gitlab.com canonical repo id", () => {
    expect(resolveForgeKind("https://gitlab.com/acme/widgets")).toBe("gitlab");
  });

  test("explicit forge wins over hostname inference", () => {
    expect(
      resolveForgeKind("https://git.example.com/acme/widgets", {
        explicit: "gitlab",
      }),
    ).toBe("gitlab");
  });

  test("host map selects forge for custom hosts", () => {
    expect(
      resolveForgeKind("https://git.example.com/acme/widgets", {
        hostMap: { "git.example.com": "gitlab" },
      }),
    ).toBe("gitlab");
  });

  test("unknown host without explicit or map fails closed", () => {
    try {
      resolveForgeKind("https://git.example.com/acme/widgets");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(400);
      expect(String(error)).toContain("Cannot infer forge");
    }
  });

  test("invalid URL fails closed", () => {
    try {
      resolveForgeKind("not-a-url");
      expect.unreachable("expected forge API error");
    } catch (error) {
      expect(isForgeApiError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(400);
    }
  });
});
