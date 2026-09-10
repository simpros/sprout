import { describe, expect, test } from "bun:test";
import {
  mergeConnectionEnvFile,
  parseEnvRenames,
  readEnvFileValue,
  resolveEnvKeyNames,
} from "./env-file.ts";

const values = {
  databaseUrl: "postgres://u:p@localhost:5432/db",
  host: "localhost",
  port: 5432,
  user: "u",
  password: "p",
  database: "db",
};

describe("mergeConnectionEnvFile", () => {
  test("creates file content when missing", () => {
    const out = mergeConnectionEnvFile(null, values);
    expect(out).toContain("DATABASE_URL=postgres://u:p@localhost:5432/db\n");
    expect(out).toContain("PGHOST=localhost\n");
    expect(out).toContain("PGUSER=u\n");
    expect(out).toContain("PGPASSWORD=p\n");
    expect(out).toContain("PGDATABASE=db\n");
    expect(out).toContain("PGPORT=5432\n");
  });

  test("rewrites managed keys and preserves others", () => {
    const existing = [
      "FOO=bar",
      "PGHOST=old",
      "# keep",
      "DATABASE_URL=old-url",
      "",
    ].join("\n");
    const out = mergeConnectionEnvFile(existing, values);
    expect(out).toContain("FOO=bar\n");
    expect(out).toContain("# keep\n");
    expect(out).toContain("PGHOST=localhost\n");
    expect(out).toContain("DATABASE_URL=postgres://u:p@localhost:5432/db\n");
    expect(out).not.toContain("PGHOST=old");
  });

  test("honors renames", () => {
    const names = resolveEnvKeyNames({
      DATABASE_URL: "APP_DATABASE_URL",
      PGHOST: "DATABASE_HOST",
    });
    const out = mergeConnectionEnvFile(null, values, names);
    expect(out).toContain("APP_DATABASE_URL=");
    expect(out).toContain("DATABASE_HOST=localhost\n");
    expect(out).not.toMatch(/^DATABASE_URL=/m);
    expect(out).not.toMatch(/^PGHOST=/m);
  });
});

describe("parseEnvRenames", () => {
  test("parses LOGICAL=NAME pairs using canonical PG* + DATABASE_URL", () => {
    expect(
      parseEnvRenames(["DATABASE_URL=APP_URL", "PGHOST=HOST"]),
    ).toEqual({
      ok: true,
      value: { DATABASE_URL: "APP_URL", PGHOST: "HOST" },
    });
  });

  test("rejects unknown logical keys and camelCase leftovers", () => {
    expect(parseEnvRenames(["NOPE=X"]).ok).toBe(false);
    expect(parseEnvRenames(["databaseUrl=X"]).ok).toBe(false);
  });
});

describe("readEnvFileValue", () => {
  test("reads first matching key", () => {
    expect(readEnvFileValue("PGPASSWORD=secret\nFOO=1\n", "PGPASSWORD")).toBe(
      "secret",
    );
    expect(readEnvFileValue(null, "PGPASSWORD")).toBeUndefined();
  });
});
