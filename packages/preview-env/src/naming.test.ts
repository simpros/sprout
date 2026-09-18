import { describe, expect, test } from "bun:test";
import { parseSqliteVolumeName, sqliteVolumeName } from "./naming.ts";

describe("sqlite volume naming", () => {
  test("builds one -sqlite volume per preview", () => {
    expect(sqliteVolumeName("myapp", 42)).toBe("sprout-myapp-pr-42-sqlite");
  });

  test("round-trips through the volume parser", () => {
    expect(parseSqliteVolumeName(sqliteVolumeName("myapp", 42))).toEqual({
      slug: "myapp",
      prId: 42,
    });
  });

  test("rejects non-sqlite volume names", () => {
    expect(parseSqliteVolumeName("sprout-myapp-pr-42")).toBeNull();
    expect(parseSqliteVolumeName("sprout-myapp-pr-42-seed")).toBeNull();
    expect(parseSqliteVolumeName("other")).toBeNull();
    expect(parseSqliteVolumeName("sprout-myapp-pr-0-sqlite")).toBeNull();
  });
});
