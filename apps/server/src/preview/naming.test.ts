import { describe, expect, test } from "bun:test";
import {
  parsePreviewContainerName,
  parsePreviewDatabaseName,
  previewContainerName,
  seedImageRunName,
} from "./naming.ts";

describe("parsePreviewDatabaseName (re-export)", () => {
  test("parses sprout_<slug>_pr<id>", () => {
    expect(parsePreviewDatabaseName("sprout_widgets_pr42")).toEqual({
      slug: "widgets",
      prId: 42,
    });
  });

  test("rejects non-preview names", () => {
    expect(parsePreviewDatabaseName("postgres")).toBeNull();
    expect(parsePreviewDatabaseName("sprout_widgets")).toBeNull();
    expect(parsePreviewDatabaseName("sprout_widgets_pr")).toBeNull();
    expect(parsePreviewDatabaseName("prev_widgets_pr42")).toBeNull();
  });
});

describe("parsePreviewContainerName", () => {
  test("round-trips sprout-<slug>-pr-<id>", () => {
    expect(previewContainerName("widgets", 7)).toBe("sprout-widgets-pr-7");
    expect(parsePreviewContainerName("sprout-widgets-pr-7")).toEqual({
      slug: "widgets",
      prId: 7,
    });
  });

  test("seed run uses -seed suffix outside catalog regex", () => {
    expect(seedImageRunName("widgets", 7)).toBe("sprout-widgets-pr-7-seed");
    expect(parsePreviewContainerName("sprout-widgets-pr-7-seed")).toBeNull();
  });

  test("rejects non-preview names", () => {
    expect(parsePreviewContainerName("sprout-widgets")).toBeNull();
    expect(parsePreviewContainerName("widgets-pr-7")).toBeNull();
    expect(parsePreviewContainerName("sprout-widgets-pr-")).toBeNull();
    expect(parsePreviewContainerName("pb-widgets-pr-7")).toBeNull();
  });
});
