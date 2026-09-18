import { describe, expect, test } from "bun:test";
import {
  dbSpecIssueMessage,
  defaultDbSpec,
  normalizeDbSpec,
  parseDbSpec,
  sqliteDatabaseUrl,
} from "./db.ts";

describe("parseDbSpec", () => {
  test("absent block means no override", () => {
    expect(parseDbSpec(undefined)).toEqual({ ok: true, value: undefined });
  });

  test("empty block means no override", () => {
    expect(parseDbSpec({})).toEqual({ ok: true, value: undefined });
  });

  test("defaults provider to postgres with sqlite paths", () => {
    expect(parseDbSpec({ provider: "postgres" })).toEqual({
      ok: true,
      value: { provider: "postgres", path: "/data", file: "preview.db" },
    });
  });

  test("parses a sqlite block", () => {
    expect(
      parseDbSpec({ provider: "sqlite", path: "/data", file: "app.db" }),
    ).toEqual({
      ok: true,
      value: { provider: "sqlite", path: "/data", file: "app.db" },
    });
  });

  test("trims a trailing slash from path", () => {
    expect(parseDbSpec({ provider: "sqlite", path: "/data/" })).toEqual({
      ok: true,
      value: { provider: "sqlite", path: "/data", file: "preview.db" },
    });
  });

  test("rejects unknown keys", () => {
    expect(parseDbSpec({ engine: "sqlite" })).toEqual({
      ok: false,
      issue: { code: "unknown_db_key", key: "engine" },
    });
  });

  test("rejects unsupported providers", () => {
    expect(parseDbSpec({ provider: "mysql" })).toEqual({
      ok: false,
      issue: { code: "invalid_db_provider", provider: "mysql" },
    });
    expect(dbSpecIssueMessage({ code: "invalid_db_provider", provider: "x" })).toBe(
      'db.provider must be postgres or sqlite (got "x")',
    );
  });

  test("rejects relative or blank paths", () => {
    expect(parseDbSpec({ path: "data" })).toEqual({
      ok: false,
      issue: { code: "invalid_db_path", path: "data" },
    });
    expect(parseDbSpec({ path: "   " })).toEqual({
      ok: false,
      issue: { code: "invalid_db_path", path: "   " },
    });
  });

  test("rejects file names with slashes", () => {
    expect(parseDbSpec({ file: "a/b.db" })).toEqual({
      ok: false,
      issue: { code: "invalid_db_file", file: "a/b.db" },
    });
    expect(parseDbSpec({ file: "" })).toEqual({
      ok: false,
      issue: { code: "invalid_db_file", file: "" },
    });
  });

  test("rejects non-mapping blocks", () => {
    expect(parseDbSpec("sqlite")).toEqual({
      ok: false,
      issue: { code: "invalid_db_block" },
    });
  });
});

describe("sqlite connection string", () => {
  test("builds a file: URL from path and file", () => {
    expect(sqliteDatabaseUrl("/data", "preview.db")).toBe(
      "file:/data/preview.db",
    );
    expect(sqliteDatabaseUrl("/data", "app.db")).toBe("file:/data/app.db");
  });

  test("normalizeDbSpec falls back to the postgres default", () => {
    expect(normalizeDbSpec(undefined)).toEqual(defaultDbSpec());
    expect(defaultDbSpec().provider).toBe("postgres");
  });
});
