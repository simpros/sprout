import { describe, expect, test } from "bun:test";
import {
  parsePreviewContainerName,
  parsePreviewDatabaseName,
} from "./naming.ts";

describe("parsePreviewDatabaseName (re-export)", () => {
  test("parses prev_<slug>_pr<id>", () => {
    expect(parsePreviewDatabaseName("prev_widgets_pr42")).toEqual({
      slug: "widgets",
      prId: 42,
    });
  });

  test("rejects non-preview names", () => {
    expect(parsePreviewDatabaseName("postgres")).toBeNull();
    expect(parsePreviewDatabaseName("prev_widgets")).toBeNull();
    expect(parsePreviewDatabaseName("prev_widgets_pr")).toBeNull();
  });
});

describe("parsePreviewContainerName", () => {
  test("parses sprout-<slug>-pr-<id>", () => {
    expect(parsePreviewContainerName("sprout-widgets-pr-7")).toEqual({
      slug: "widgets",
      prId: 7,
    });
  });

  test("rejects non-preview names", () => {
    expect(parsePreviewContainerName("sprout-widgets")).toBeNull();
    expect(parsePreviewContainerName("widgets-pr-7")).toBeNull();
    expect(parsePreviewContainerName("sprout-widgets-pr-")).toBeNull();
  });
});
