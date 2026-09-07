import { describe, expect, test } from "bun:test";
import { validatePreviewEnvMap } from "./index.ts";

describe("validatePreviewEnvMap", () => {
  test("absent or empty → undefined", () => {
    expect(validatePreviewEnvMap(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(validatePreviewEnvMap({})).toEqual({ ok: true, value: undefined });
  });

  test("accepts identity and partial maps", () => {
    expect(
      validatePreviewEnvMap({
        PGHOST: "PGHOST",
        PGUSER: "DATABASE_USER",
      }),
    ).toEqual({
      ok: true,
      value: { PGHOST: "PGHOST", PGUSER: "DATABASE_USER" },
    });
  });

  test("rejects unknown keys", () => {
    expect(validatePreviewEnvMap({ DATABASE_URL: "x" }, "preview.env")).toEqual(
      {
        ok: false,
        error: "unknown key: preview.env.DATABASE_URL",
      },
    );
  });

  test("rejects non-string, empty, and invalid targets", () => {
    expect(validatePreviewEnvMap({ PGHOST: 5432 }, "preview.env")).toEqual({
      ok: false,
      error: "preview.env.PGHOST must be a string",
    });
    expect(validatePreviewEnvMap({ PGHOST: "" }, "preview.env")).toEqual({
      ok: false,
      error: "preview.env.PGHOST is required",
    });
    expect(validatePreviewEnvMap({ PGHOST: "bad-name" }, "preview.env")).toEqual(
      {
        ok: false,
        error: "preview.env.PGHOST is invalid",
      },
    );
  });

  test("rejects target collisions after trim", () => {
    expect(
      validatePreviewEnvMap(
        { PGHOST: "DATABASE_HOST", PGPORT: " DATABASE_HOST " },
        "preview.env",
      ),
    ).toEqual({
      ok: false,
      error: "preview.env: target collision: DATABASE_HOST",
    });
  });

  test("rejects non-mapping", () => {
    expect(validatePreviewEnvMap(["PGHOST"], "env")).toEqual({
      ok: false,
      error: "env must be a mapping",
    });
  });
});
