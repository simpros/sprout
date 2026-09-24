import { describe, expect, test } from "bun:test";
import { PG_IDENT_MAX } from "@sprout/preview-db";
import {
  assertPreviewDbName,
  isPreviewDbName,
  parsePreviewDatabaseName,
  PREVIEW_DB_NAME_MAX,
  PREVIEW_DB_NAME_MAX_SINGLE,
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
    const longSlug = "a".repeat(PREVIEW_DB_NAME_MAX - "sprout_".length - "_pr1".length + 1);
    const tooLong = previewDbName(longSlug, 1);
    expect(tooLong.length).toBeGreaterThan(PREVIEW_DB_NAME_MAX);
    expect(validatePreviewIdentity(longSlug, 1, "dual")).toBe("invalid_slug");
  });

  test("catalog read stays permissive at PG_IDENT_MAX across a mode flip", () => {
    const longSlug = "a".repeat(PREVIEW_DB_NAME_MAX - "sprout_".length - "_pr1".length + 1);
    const tooLong = previewDbName(longSlug, 1);
    expect(tooLong.length).toBeLessThanOrEqual(PREVIEW_DB_NAME_MAX_SINGLE);
    expect(isPreviewDbName(tooLong)).toBe(true);
    expect(parsePreviewDatabaseName(tooLong)).toEqual({ slug: longSlug, prId: 1 });
    expect(() => assertPreviewDbName(tooLong)).not.toThrow();
  });

  test("single allows names up to PG_IDENT_MAX; dual stays on the companion budget", () => {
    const dualSlug = "a".repeat(PREVIEW_DB_NAME_MAX - "sprout_".length - "_pr1".length + 1);
    expect(validatePreviewIdentity(dualSlug, 1, "dual")).toBe("invalid_slug");
    expect(validatePreviewIdentity(dualSlug, 1, "single")).toBeNull();
    const overSingle = "a".repeat(
      PREVIEW_DB_NAME_MAX_SINGLE - "sprout_".length - "_pr1".length + 1,
    );
    expect(validatePreviewIdentity(overSingle, 1, "single")).toBe("invalid_slug");
    expect(PREVIEW_DB_NAME_MAX_SINGLE).toBe(PG_IDENT_MAX);
  });

  test("validatePreviewIdentity accepts names that fit companion budget", () => {
    expect(validatePreviewIdentity("widgets", 42, "dual")).toBeNull();
    const maxSlug = "a".repeat(PREVIEW_DB_NAME_MAX - "sprout_".length - "_pr1".length);
    expect(validatePreviewIdentity(maxSlug, 1, "dual")).toBeNull();
    expect(previewDbName(maxSlug, 1).length).toBe(PREVIEW_DB_NAME_MAX);
  });
});
