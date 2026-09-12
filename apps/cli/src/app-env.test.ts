import { describe, expect, test } from "bun:test";
import { mergeAppEnv, mergeSeedEnv } from "./app-env.ts";

describe("mergeAppEnv", () => {
  test("yaml-only → KEY=VALUE list", () => {
    expect(
      mergeAppEnv({ BETTER_AUTH_URL: "https://pr.example.com" }, undefined, [], []),
    ).toEqual({
      ok: true,
      value: ["BETTER_AUTH_URL=https://pr.example.com"],
    });
  });

  test("files then flags overwrite yaml; insertion order preserved", () => {
    expect(
      mergeAppEnv(
        { SHARED: "from-yaml", KEEP: "yaml" },
        undefined,
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

  test("invalid flag fails fast without echoing the entry", () => {
    expect(mergeAppEnv({ OK: "1" }, undefined, [], ["NOTAKEY"])).toEqual({
      ok: false,
      error: "invalid --app-env (expected KEY=VALUE)",
    });
    expect(mergeAppEnv(undefined, undefined, [], ["=novalue"])).toEqual({
      ok: false,
      error: "invalid --app-env (expected KEY=VALUE)",
    });
    expect(mergeAppEnv(undefined, undefined, [], ["SECRET_VALUE"])).toEqual({
      ok: false,
      error: "invalid --app-env (expected KEY=VALUE)",
    });
  });

  test("invalid dotenv line fails with path and line number, without the line", () => {
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "ci.env", content: "OK=1\nNOTAKEY\n" }],
        [],
      ),
    ).toEqual({
      ok: false,
      error: "invalid --app-env-file ci.env:2: expected KEY=VALUE",
    });
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "/tmp/x.env", content: "=novalue\n" }],
        [],
      ),
    ).toEqual({
      ok: false,
      error: "invalid --app-env-file /tmp/x.env:1: expected KEY=VALUE",
    });
  });

  test("malformed secret line is never echoed in the error", () => {
    const secret = "sk_live_do_not_log_me";
    const result = mergeAppEnv(
      undefined,
      undefined,
      [{ pathLabel: "ci.env", content: `${secret}\n` }],
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(secret);
  });

  test("strips an optional `export ` prefix", () => {
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [
          {
            pathLabel: "ci.env",
            content: "export TOKEN=abc\nexport OTHER=def\nexport=literal\n",
          },
        ],
        [],
      ),
    ).toEqual({
      ok: true,
      value: ["TOKEN=abc", "OTHER=def", "export=literal"],
    });
  });

  test("file and flag values are expanded by the expander", () => {
    const expand = (_key: string, value: string) =>
      ({ ok: true, value: value.replace("{hostname}", "pr-9.example.com") }) as const;
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "ci.env", content: "AUTH_URL=https://{hostname}\n" }],
        ["API_URL=https://{hostname}/api"],
        expand,
      ),
    ).toEqual({
      ok: true,
      value: [
        "AUTH_URL=https://pr-9.example.com",
        "API_URL=https://pr-9.example.com/api",
      ],
    });
  });

  test("expander errors name the key and source", () => {
    const expand = (_key: string, value: string) =>
      value.includes("{host}")
        ? ({ ok: false, error: "unknown placeholder {host}" }) as const
        : ({ ok: true, value }) as const;
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "ci.env", content: "OK=1\nORIGIN={host}\n" }],
        [],
        expand,
      ),
    ).toEqual({
      ok: false,
      error: "invalid --app-env-file ci.env:2: ORIGIN: unknown placeholder {host}",
    });
    expect(mergeAppEnv(undefined, undefined, [], ["ORIGIN={host}"], expand)).toEqual(
      {
        ok: false,
        error: "--app-env ORIGIN: unknown placeholder {host}",
      },
    );
  });

  test("required key missing fails naming the key", () => {
    expect(
      mergeAppEnv(
        { BETTER_AUTH_URL: "https://pr.example.com" },
        ["STRIPE_API_KEY"],
        [{ pathLabel: "ci.env", content: "OTHER=1\n" }],
        [],
      ),
    ).toEqual({
      ok: false,
      error:
        "preview.app_env.STRIPE_API_KEY: required value missing (supply it via --app-env-file, SPROUT_APP_ENV, or --app-env)",
    });
  });

  test("required key satisfied by a file or flag passes", () => {
    expect(
      mergeAppEnv(
        undefined,
        ["STRIPE_API_KEY"],
        [{ pathLabel: "ci.env", content: "STRIPE_API_KEY=sk_live\n" }],
        [],
      ),
    ).toEqual({ ok: true, value: ["STRIPE_API_KEY=sk_live"] });
    expect(
      mergeAppEnv(undefined, ["STRIPE_API_KEY"], [], ["STRIPE_API_KEY=sk_live"]),
    ).toEqual({ ok: true, value: ["STRIPE_API_KEY=sk_live"] });
  });

  test("empty / comments-only dotenv → no keys from file", () => {
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "empty.env", content: "" }],
        [],
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "c.env", content: "# only\n\n" }],
        [],
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  test("values may contain `=`", () => {    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [{ pathLabel: "p.env", content: "FOO=bar=baz\n" }],
        [],
      ),
    ).toEqual({
      ok: true,
      value: ["FOO=bar=baz"],
    });
  });

  test("keys are trimmed and matching quotes are stripped", () => {
    expect(
      mergeAppEnv(
        undefined,
        undefined,
        [
          {
            pathLabel: "q.env",
            content:
              'PADDED =spaced\nDOUBLE="a b"\nSINGLE=\'c d\'\nUNBALANCED="oops\nEMPTY=\n',
          },
        ],
        [],
      ),
    ).toEqual({
      ok: true,
      value: [
        "PADDED=spaced",
        "DOUBLE=a b",
        "SINGLE=c d",
        'UNBALANCED="oops',
        "EMPTY=",
      ],
    });
  });

  test("empty yaml, files, and flags → omit", () => {
    expect(mergeAppEnv(undefined, undefined, [], [])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(mergeAppEnv({}, undefined, [], [])).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe("mergeSeedEnv", () => {
  test("file then flags; later wins", () => {
    expect(
      mergeSeedEnv(
        [{ pathLabel: "seed.env", content: "A=file\nSHARED=file\n" }],
        ["SHARED=flag"],
      ),
    ).toEqual({ ok: true, value: ["A=file", "SHARED=flag"] });
  });

  test("uses seed-specific labels in errors", () => {
    expect(mergeSeedEnv([], ["NOTAKEY"])).toEqual({
      ok: false,
      error: "invalid --seed-env (expected KEY=VALUE)",
    });
    expect(
      mergeSeedEnv([{ pathLabel: "seed.env", content: "NOTAKEY\n" }], []),
    ).toEqual({
      ok: false,
      error: "invalid --seed-env-file seed.env:1: expected KEY=VALUE",
    });
  });
});
