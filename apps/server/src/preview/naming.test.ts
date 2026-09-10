import { describe, expect, test } from "bun:test";
import {
  parsePreviewContainerName,
  previewContainerName,
  seedImageRunName,
} from "./naming.ts";

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
