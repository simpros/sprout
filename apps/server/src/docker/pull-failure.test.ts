import { describe, expect, test } from "bun:test";
import { extractPullDetail } from "./pull-failure.ts";

describe("extractPullDetail", () => {
  test("strips Docker pull prefix", () => {
    expect(
      extractPullDetail(
        new Error("Docker pull registry.example/app:1 failed: access forbidden"),
      ),
    ).toBe("access forbidden");
  });

  test("keeps raw message when prefix absent", () => {
    expect(extractPullDetail(new Error("registry blip"))).toBe("registry blip");
  });

  test("truncates long details", () => {
    const long = "x".repeat(250);
    expect(extractPullDetail(new Error(`Docker pull img:tag failed: ${long}`))).toBe(
      `${"x".repeat(197)}...`,
    );
  });

  test("falls back for unknown thrown values", () => {
    expect(extractPullDetail(null)).toBe("pull failed");
  });
});
