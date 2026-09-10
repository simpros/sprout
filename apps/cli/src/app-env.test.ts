import { describe, expect, test } from "bun:test";
import {
  mergeAppEnv,
  parseDotenv,
  resolveAppEnvFilePath,
} from "./app-env.ts";

describe("parseDotenv", () => {
  test("parses KEY=VALUE lines; skips blanks and comments", () => {
    expect(
      parseDotenv(
        `# secrets for preview
BETTER_AUTH_SECRET=sekrit

FOO=bar=baz
# trailing
`,
        "preview.env",
      ),
    ).toEqual({
      ok: true,
      value: ["BETTER_AUTH_SECRET=sekrit", "FOO=bar=baz"],
    });
  });

  test("rejects invalid lines with path and line number", () => {
    expect(parseDotenv("OK=1\nNOTAKEY\n", "ci.env")).toEqual({
      ok: false,
      error: "invalid --app-env-file ci.env:2: NOTAKEY",
    });
    expect(parseDotenv("=novalue\n", "/tmp/x.env")).toEqual({
      ok: false,
      error: "invalid --app-env-file /tmp/x.env:1: =novalue",
    });
  });

  test("empty / comments-only → empty list", () => {
    expect(parseDotenv("", "empty.env")).toEqual({ ok: true, value: [] });
    expect(parseDotenv("# only\n\n", "c.env")).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe("mergeAppEnv", () => {
  test("yaml-only → KEY=VALUE list", () => {
    expect(
      mergeAppEnv({ BETTER_AUTH_URL: "https://pr.example.com" }, [], []),
    ).toEqual({
      ok: true,
      value: ["BETTER_AUTH_URL=https://pr.example.com"],
    });
  });

  test("files then flags overwrite yaml; insertion order preserved", () => {
    expect(
      mergeAppEnv(
        { SHARED: "from-yaml", KEEP: "yaml" },
        ["SHARED=from-file", "FILE_ONLY=1"],
        ["SHARED=from-cli", "NEW=flag"],
      ),
    ).toEqual({
      ok: true,
      value: [
        "SHARED=from-cli",
        "KEEP=yaml",
        "FILE_ONLY=1",
        "NEW=flag",
      ],
    });
  });

  test("later file overwrites earlier file on duplicate keys", () => {
    expect(
      mergeAppEnv(
        undefined,
        ["A=1", "SHARED=file1", "B=2"],
        [],
      ),
    ).toEqual({
      ok: true,
      value: ["A=1", "SHARED=file1", "B=2"],
    });
    expect(
      mergeAppEnv(
        undefined,
        ["SHARED=file1", "A=1", "SHARED=file2"],
        [],
      ),
    ).toEqual({
      ok: true,
      value: ["SHARED=file2", "A=1"],
    });
  });

  test("invalid flag fails fast", () => {
    expect(mergeAppEnv({ OK: "1" }, [], ["NOTAKEY"])).toEqual({
      ok: false,
      error: "invalid --app-env: NOTAKEY",
    });
    expect(mergeAppEnv(undefined, [], ["=novalue"])).toEqual({
      ok: false,
      error: "invalid --app-env: =novalue",
    });
  });

  test("empty yaml, files, and flags → omit", () => {
    expect(mergeAppEnv(undefined, [], [])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(mergeAppEnv({}, [], [])).toEqual({ ok: true, value: undefined });
  });
});

describe("resolveAppEnvFilePath", () => {
  test("keeps absolute paths; joins relative to cwd", () => {
    expect(resolveAppEnvFilePath("/work", "/tmp/a.env")).toBe("/tmp/a.env");
    expect(resolveAppEnvFilePath("/work", "preview.env")).toBe(
      "/work/preview.env",
    );
  });
});
