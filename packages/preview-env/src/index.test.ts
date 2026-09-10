import { describe, expect, test } from "bun:test";
import { parsePreviewEnvMap } from "./index.ts";

describe("parsePreviewEnvMap", () => {
  test("absent or empty map means no remapping", () => {
    expect(parsePreviewEnvMap(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parsePreviewEnvMap({})).toEqual({ ok: true, value: undefined });
  });

  test("accepts identity and partial maps", () => {
    expect(
      parsePreviewEnvMap({ PGHOST: "PGHOST", PGUSER: "DATABASE_USER" }),
    ).toEqual({
      ok: true,
      value: { PGHOST: "PGHOST", PGUSER: "DATABASE_USER" },
    });
  });

  test("accepts PGAPPUSER / PGAPPPASSWORD remap", () => {
    expect(
      parsePreviewEnvMap({
        PGAPPUSER: "APP_DATABASE_USER",
        PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
      }),
    ).toEqual({
      ok: true,
      value: {
        PGAPPUSER: "APP_DATABASE_USER",
        PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
      },
    });
  });

  test("rejects unknown keys", () => {
    expect(parsePreviewEnvMap({ DATABASE_URL: "DATABASE_URL" })).toEqual({
      ok: false,
      issue: { code: "unknown_env_key", key: "DATABASE_URL" },
    });
  });

  test("rejects empty targets", () => {
    expect(parsePreviewEnvMap({ PGHOST: "" })).toEqual({
      ok: false,
      issue: { code: "empty_env_target", key: "PGHOST" },
    });
    expect(parsePreviewEnvMap({ PGHOST: "   " })).toEqual({
      ok: false,
      issue: { code: "empty_env_target", key: "PGHOST" },
    });
  });

  test("rejects invalid targets", () => {
    expect(parsePreviewEnvMap({ PGHOST: "bad-name" })).toEqual({
      ok: false,
      issue: { code: "invalid_env_target", key: "PGHOST" },
    });
  });

  test("rejects target collisions", () => {
    expect(
      parsePreviewEnvMap({
        PGHOST: "DATABASE_HOST",
        PGPORT: "DATABASE_HOST",
      }),
    ).toEqual({
      ok: false,
      issue: {
        code: "env_target_collision",
        key: "PGPORT",
        target: "DATABASE_HOST",
        priorKey: "PGHOST",
      },
    });
  });
});
