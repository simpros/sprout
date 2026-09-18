import { describe, expect, test } from "bun:test";
import {
  parsePreviewContainerName,
  parseSqliteVolumeName,
  previewContainerName,
  previewServiceContainerName,
  seedImageRunName,
  sqliteVolumeName,
} from "./naming.ts";

describe("parsePreviewContainerName", () => {
  test("round-trips sprout-<slug>-pr-<id>", () => {
    expect(previewContainerName("widgets", 7)).toBe("sprout-widgets-pr-7");
    expect(parsePreviewContainerName("sprout-widgets-pr-7")).toEqual({
      slug: "widgets",
      prId: 7,
      kind: "app",
    });
  });

  test("catalogs service containers with -svc-<name>", () => {
    expect(previewServiceContainerName("widgets", 7, "api")).toBe(
      "sprout-widgets-pr-7-svc-api",
    );
    expect(parsePreviewContainerName("sprout-widgets-pr-7-svc-api")).toEqual({
      slug: "widgets",
      prId: 7,
      kind: "service",
      serviceName: "api",
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

describe("sqlite volume names", () => {
  test("round-trips sprout-<slug>-pr-<id>-sqlite", () => {
    expect(sqliteVolumeName("myapp", 42)).toBe("sprout-myapp-pr-42-sqlite");
    expect(parseSqliteVolumeName("sprout-myapp-pr-42-sqlite")).toEqual({
      slug: "myapp",
      prId: 42,
    });
  });

  test("rejects app, service, seed, and foreign volume names", () => {
    expect(parseSqliteVolumeName("sprout-myapp-pr-42")).toBeNull();
    expect(parseSqliteVolumeName("sprout-myapp-pr-42-svc-api")).toBeNull();
    expect(parseSqliteVolumeName("sprout-myapp-pr-42-seed")).toBeNull();
    expect(parseSqliteVolumeName("sprout-myapp-pr-0-sqlite")).toBeNull();
    expect(parseSqliteVolumeName("some-other-volume")).toBeNull();
  });
});
