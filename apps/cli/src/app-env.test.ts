import { describe, expect, test } from "bun:test";
import { mergeAppEnv } from "./app-env.ts";

describe("mergeAppEnv", () => {
  test("yaml-only → KEY=VALUE list", () => {
    expect(
      mergeAppEnv({ BETTER_AUTH_URL: "https://pr.example.com" }, []),
    ).toEqual({
      ok: true,
      value: ["BETTER_AUTH_URL=https://pr.example.com"],
    });
  });

  test("flags-only → KEY=VALUE list", () => {
    expect(mergeAppEnv(undefined, ["SECRET=sekrit", "FOO=bar"])).toEqual({
      ok: true,
      value: ["SECRET=sekrit", "FOO=bar"],
    });
  });

  test("flags overwrite yaml on duplicate keys; insertion order preserved", () => {
    expect(
      mergeAppEnv(
        { SHARED: "from-yaml", KEEP: "yaml" },
        ["SHARED=from-cli", "NEW=flag"],
      ),
    ).toEqual({
      ok: true,
      value: ["SHARED=from-cli", "KEEP=yaml", "NEW=flag"],
    });
  });

  test("invalid flag fails fast", () => {
    expect(mergeAppEnv({ OK: "1" }, ["NOTAKEY"])).toEqual({
      ok: false,
      error: "invalid --app-env: NOTAKEY",
    });
    expect(mergeAppEnv(undefined, ["=novalue"])).toEqual({
      ok: false,
      error: "invalid --app-env: =novalue",
    });
  });

  test("empty yaml and flags → omit", () => {
    expect(mergeAppEnv(undefined, [])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(mergeAppEnv({}, [])).toEqual({ ok: true, value: undefined });
  });
});
