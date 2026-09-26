import { describe, expect, test } from "bun:test";
import {
  parsePreviewVolumes,
  previewVolumeIssueMessage,
} from "./volumes.ts";

describe("parsePreviewVolumes", () => {
  test("absent stays absent; empty list stays absent", () => {
    expect(parsePreviewVolumes(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parsePreviewVolumes([])).toEqual({ ok: true, value: undefined });
  });

  test("normalizes trailing slashes", () => {
    expect(parsePreviewVolumes(["/data/documents/"])).toEqual({
      ok: true,
      value: ["/data/documents"],
    });
  });

  test("rejects a non-list", () => {
    const parsed = parsePreviewVolumes("/data");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(previewVolumeIssueMessage("preview.volumes", parsed.issue)).toBe(
        "preview.volumes must be a list",
      );
    }
  });

  test("rejects relative paths and dotdot with the key named", () => {
    for (const entry of ["data/documents", "a/../b", "/data/../secrets"]) {
      const parsed = parsePreviewVolumes([entry]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(
          previewVolumeIssueMessage("preview.volumes", parsed.issue),
        ).toContain("preview.volumes[0]");
      }
    }
  });

  test("rejects duplicates after normalization", () => {
    const parsed = parsePreviewVolumes(["/data", "/data/"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issue.code).toBe("volume_duplicate");
      expect(
        previewVolumeIssueMessage("preview.volumes", parsed.issue),
      ).toContain("preview.volumes");
    }
  });

  test("rejects collision with the sqlite db.path", () => {
    const parsed = parsePreviewVolumes(["/data"], { dbPath: "/data" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issue.code).toBe("volume_collides_db_path");
      expect(
        previewVolumeIssueMessage("preview.volumes", parsed.issue),
      ).toContain("db.path");
    }
  });
});
