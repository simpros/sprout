import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateToken, hashToken, parseBearer } from "./tokens.ts";

describe("tokens", () => {
  test("hashToken matches SHA-256 hex", () => {
    const token = "sprout_test";
    expect(hashToken(token)).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });

  test("parseBearer extracts token from Authorization header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
  });

  test("generateToken returns sprout_ prefix", () => {
    expect(generateToken().startsWith("sprout_")).toBe(true);
  });
});
