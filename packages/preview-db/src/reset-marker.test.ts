import { describe, expect, test } from "bun:test";
import { parseResetMarkerToken } from "./reset-marker.ts";

describe("parseResetMarkerToken", () => {
  test("trims and accepts a plain token", () => {
    expect(parseResetMarkerToken("  ada-1  ")).toBe("ada-1");
  });

  test("rejects empty, oversize, and markup-carrying tokens", () => {
    expect(parseResetMarkerToken("")).toBeNull();
    expect(parseResetMarkerToken("   ")).toBeNull();
    expect(parseResetMarkerToken("a<b")).toBeNull();
    expect(parseResetMarkerToken("a>b")).toBeNull();
    expect(parseResetMarkerToken("a\nb")).toBeNull();
    expect(parseResetMarkerToken("x".repeat(257))).toBeNull();
    expect(parseResetMarkerToken("x".repeat(256))).toBe("x".repeat(256));
  });
});
