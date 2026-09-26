import { describe, expect, test } from "bun:test";
import {
  dataVolumeName,
  parseDataVolumeName,
  parseSqliteVolumeName,
  sqliteVolumeName,
} from "./naming.ts";

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

describe("data volume naming", () => {
  test("builds one -data-<n> volume per preview.volumes entry", () => {
    expect(dataVolumeName("myapp", 42, 0)).toBe("sprout-myapp-pr-42-data-0");
    expect(dataVolumeName("myapp", 42, 1)).toBe("sprout-myapp-pr-42-data-1");
  });

  test("round-trips through the volume parser", () => {
    expect(parseDataVolumeName(dataVolumeName("myapp", 42, 0))).toEqual({
      slug: "myapp",
      prId: 42,
      index: 0,
    });
  });

  test("rejects non-data volume names", () => {
    expect(parseDataVolumeName("sprout-myapp-pr-42-sqlite")).toBeNull();
    expect(parseDataVolumeName("sprout-myapp-pr-42")).toBeNull();
    expect(parseDataVolumeName("other")).toBeNull();
    expect(parseDataVolumeName("sprout-myapp-pr-0-data-0")).toBeNull();
  });
});
