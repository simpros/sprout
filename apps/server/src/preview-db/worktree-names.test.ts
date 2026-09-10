import { describe, expect, test } from "bun:test";
import {
  assertWorktreeObjectName,
  isWorktreeObjectName,
  normalizeWorktreeSlug,
  worktreeObjectName,
} from "./worktree-names.ts";

describe("normalizeWorktreeSlug", () => {
  test("lowercases, maps non [a-z0-9-] to -, collapses, trims", () => {
    expect(normalizeWorktreeSlug("My_Feature Branch!")).toBe("my-feature-branch");
    expect(normalizeWorktreeSlug("---Foo---")).toBe("foo");
    expect(normalizeWorktreeSlug("a--b")).toBe("a-b");
  });

  test("truncates to 40 chars without trailing hyphen", () => {
    const long = `abc-${"x".repeat(50)}`;
    const slug = normalizeWorktreeSlug(long);
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(40);
    expect(slug!.endsWith("-")).toBe(false);
  });

  test("returns null for empty after normalize", () => {
    expect(normalizeWorktreeSlug("")).toBeNull();
    expect(normalizeWorktreeSlug("---")).toBeNull();
    expect(normalizeWorktreeSlug("!!!")).toBeNull();
  });
});

describe("worktreeObjectName", () => {
  test("prefixes sprout_wt_ and folds hyphens to underscores", () => {
    expect(worktreeObjectName("my-feature")).toBe("sprout_wt_my_feature");
    expect(worktreeObjectName("widgets")).toBe("sprout_wt_widgets");
  });
});

describe("assertWorktreeObjectName", () => {
  test("accepts sprout_wt_ names only", () => {
    expect(() => assertWorktreeObjectName("sprout_wt_widgets")).not.toThrow();
    expect(() => assertWorktreeObjectName("postgres")).toThrow(/non-worktree/);
    expect(() => assertWorktreeObjectName("sprout_widgets_pr1")).toThrow(
      /non-worktree/,
    );
    expect(() => assertWorktreeObjectName("sprout_wt_")).toThrow(/non-worktree/);
    expect(isWorktreeObjectName("sprout_preview")).toBe(false);
  });
});
