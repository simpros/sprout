import { describe, expect, test } from "bun:test";
import { createPostgresPreviewDb } from "./postgres.ts";

describe("createPostgresPreviewDb", () => {
  test("rejects mixed-case preview roles (unquoted identifiers)", () => {
    expect(() =>
      createPostgresPreviewDb({
        url: "postgres://localhost/postgres",
        previewRole: "Pb_Preview",
      }),
    ).toThrow(/unsafe preview role/);
  });

  test("accepts lowercase preview roles", () => {
    expect(() =>
      createPostgresPreviewDb({
        url: "postgres://localhost/postgres",
        previewRole: "pb_preview",
      }),
    ).not.toThrow();
  });
});
