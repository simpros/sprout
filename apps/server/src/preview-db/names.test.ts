import { describe, expect, test } from "bun:test";
import {
  assertPreviewDbName,
  isPreviewDbName,
  parsePreviewDatabaseName,
  PREVIEW_DB_NAME_MAX,
  previewDbName,
  validatePreviewIdentity,
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

  test("refuses names that leave no room for companion _app role", () => {
    // sprout_ (7) + slug + _pr (3) + digits must be ≤ PREVIEW_DB_NAME_MAX (59)
    const longSlug = "a".repeat(PREVIEW_DB_NAME_MAX - "sprout_".length - "_pr1".length + 1);
    const tooLong = previewDbName(longSlug, 1);
    expect(tooLong.length).toBeGreaterThan(PREVIEW_DB_NAME_MAX);
    expect(isPreviewDbName(tooLong)).toBe(false);
    expect(parsePreviewDatabaseName(tooLong)).toBeNull();
    expect(() => assertPreviewDbName(tooLong)).toThrow(/unsafe/);
    expect(validatePreviewIdentity(longSlug, 1)).toBe("invalid_slug");
  });

  test("validatePreviewIdentity accepts names that fit companion budget", () => {
    expect(validatePreviewIdentity("widgets", 42)).toBeNull();
    const maxSlug = "a".repeat(PREVIEW_DB_NAME_MAX - "sprout_".length - "_pr1".length);
    expect(validatePreviewIdentity(maxSlug, 1)).toBeNull();
    expect(previewDbName(maxSlug, 1).length).toBe(PREVIEW_DB_NAME_MAX);
  });
});
