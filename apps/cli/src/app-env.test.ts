import { describe, expect, test } from "bun:test";
import { mergeAppEnv } from "./app-env.ts";

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
        [
          {
            pathLabel: "preview.env",
            content: `# secrets
SHARED=from-file
FILE_ONLY=1
`,
          },
        ],
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
        [
          {
            pathLabel: "a.env",
            content: "A=1\nSHARED=file1\nB=2\n",
          },
        ],
        [],
      ),
    ).toEqual({
      ok: true,
      value: ["A=1", "SHARED=file1", "B=2"],
    });
    expect(
      mergeAppEnv(
        undefined,
        [
          { pathLabel: "a.env", content: "SHARED=file1\nA=1\n" },
          { pathLabel: "b.env", content: "SHARED=file2\n" },
        ],
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

  test("invalid dotenv line fails with path and line number", () => {
    expect(
      mergeAppEnv(
        undefined,
        [{ pathLabel: "ci.env", content: "OK=1\nNOTAKEY\n" }],
        [],
      ),
    ).toEqual({
      ok: false,
      error: "invalid --app-env-file ci.env:2: NOTAKEY",
    });
    expect(
      mergeAppEnv(
        undefined,
        [{ pathLabel: "/tmp/x.env", content: "=novalue\n" }],
        [],
      ),
    ).toEqual({
      ok: false,
      error: "invalid --app-env-file /tmp/x.env:1: =novalue",
    });
  });

  test("empty / comments-only dotenv → no keys from file", () => {
    expect(
      mergeAppEnv(
        undefined,
        [{ pathLabel: "empty.env", content: "" }],
        [],
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(
      mergeAppEnv(
        undefined,
        [{ pathLabel: "c.env", content: "# only\n\n" }],
        [],
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  test("values may contain `=`", () => {
    expect(
      mergeAppEnv(
        undefined,
        [{ pathLabel: "p.env", content: "FOO=bar=baz\n" }],
        [],
      ),
    ).toEqual({
      ok: true,
      value: ["FOO=bar=baz"],
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
