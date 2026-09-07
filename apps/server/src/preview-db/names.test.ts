import { describe, expect, test } from "bun:test";
import {
  assertPreviewDbName,
  isPreviewDbName,
  parsePreviewDatabaseName,
  previewDbName,
} from "./names.ts";

describe("previewDbName / parsePreviewDatabaseName", () => {
  test("round-trips sprout_<slug>_pr<id>", () => {
    const name = previewDbName("widgets", 42);
    expect(name).toBe("sprout_widgets_pr42");
    expect(parsePreviewDatabaseName(name)).toEqual({
      slug: "widgets",
      prId: 42,
    });
  });

  test("rejects non-preview and out-of-grammar names", () => {
    expect(parsePreviewDatabaseName("postgres")).toBeNull();
    expect(parsePreviewDatabaseName("sprout_widgets")).toBeNull();
    expect(parsePreviewDatabaseName("sprout_widgets_pr")).toBeNull();
    expect(parsePreviewDatabaseName("sprout_widgets_pr0")).toBeNull();
    expect(parsePreviewDatabaseName("sprout_Widgets_pr42")).toBeNull();
    expect(parsePreviewDatabaseName("prev_widgets_pr42")).toBeNull();
    expect(isPreviewDbName("sprout_widgets_pr0")).toBe(false);
  });

  test("assertPreviewDbName refuses unsafe names", () => {
    expect(() => assertPreviewDbName("postgres")).toThrow(/unsafe/);
    expect(() => assertPreviewDbName("sprout_widgets_pr42")).not.toThrow();
  });
});
