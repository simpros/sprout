import { describe, expect, test } from "bun:test";
import {
  dbRolesIssueMessage,
  dbSpecIssueMessage,
  defaultDbSpec,
  normalizeDbSpec,
  parseDbSpec,
  requiresDatabase,
  resolveDbRoles,
  sqliteDatabaseUrl,
  type DbRolesIssue,
} from "./db.ts";

const _rolesIssueShape: DbRolesIssue = {
  code: "db_roles_requires_provider",
  provider: "sqlite",
};
void _rolesIssueShape;

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

  test("parses a none block", () => {
    expect(parseDbSpec({ provider: "none" })).toEqual({
      ok: true,
      value: { provider: "none", path: "/data", file: "preview.db" },
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
      'db.provider must be postgres, sqlite or none (got "x")',
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

  test("parses explicit db.roles single and dual", () => {
    expect(parseDbSpec({ roles: "single" })).toEqual({
      ok: true,
      value: { provider: "postgres", path: "/data", file: "preview.db", roles: "single" },
    });
    expect(parseDbSpec({ provider: "postgres", roles: "dual" })).toEqual({
      ok: true,
      value: { provider: "postgres", path: "/data", file: "preview.db", roles: "dual" },
    });
  });

  test("trims roles and rejects unknown modes", () => {
    expect(parseDbSpec({ roles: " dual " })).toEqual({
      ok: true,
      value: { provider: "postgres", path: "/data", file: "preview.db", roles: "dual" },
    });
    expect(parseDbSpec({ roles: "triple" })).toEqual({
      ok: false,
      issue: { code: "invalid_db_roles", roles: "triple" },
    });
    expect(
      dbSpecIssueMessage({ code: "invalid_db_roles", roles: "triple" }),
    ).toBe('db.roles must be single or dual (got "triple")');
  });
});

describe("resolveDbRoles", () => {
  test("absent roles with no remap defaults to single", () => {
    expect(resolveDbRoles(undefined, undefined)).toEqual({
      ok: true,
      value: "single",
    });
    expect(
      resolveDbRoles(
        { provider: "postgres", path: "/data", file: "preview.db" },
        { PGHOST: "H" },
      ),
    ).toEqual({ ok: true, value: "single" });
  });

  test("absent roles with a companion remap derives dual", () => {
    expect(
      resolveDbRoles(undefined, { PGAPPUSER: "APP_USER" }),
    ).toEqual({ ok: true, value: "dual" });
    expect(
      resolveDbRoles(undefined, { PGAPPPASSWORD: "APP_PASS" }),
    ).toEqual({ ok: true, value: "dual" });
  });

  test("explicit dual wins with or without a remap", () => {
    expect(
      resolveDbRoles(
        { provider: "postgres", path: "/data", file: "preview.db", roles: "dual" },
        undefined,
      ),
    ).toEqual({ ok: true, value: "dual" });
    expect(
      resolveDbRoles(
        { provider: "postgres", path: "/data", file: "preview.db", roles: "dual" },
        { PGAPPUSER: "APP_USER" },
      ),
    ).toEqual({ ok: true, value: "dual" });
  });

  test("explicit single plus a companion remap is a hard error naming both sides", () => {
    expect(
      resolveDbRoles(
        { provider: "postgres", path: "/data", file: "preview.db", roles: "single" },
        { PGAPPUSER: "APP_USER" },
      ),
    ).toEqual({
      ok: false,
      issue: { code: "db_roles_conflict", key: "PGAPPUSER" },
    });
    expect(
      dbRolesIssueMessage({ code: "db_roles_conflict", key: "PGAPPUSER" }),
    ).toBe(
      "preview.env.PGAPPUSER conflicts with db.roles single (remove the remap or use db.roles dual)",
    );
  });

  test("explicit roles on sqlite or none is rejected like an out-of-scope env key", () => {
    expect(
      resolveDbRoles(
        { provider: "sqlite", path: "/data", file: "preview.db", roles: "dual" },
        undefined,
      ),
    ).toEqual({
      ok: false,
      issue: { code: "db_roles_requires_provider", provider: "sqlite" },
    });
    expect(
      resolveDbRoles(
        { provider: "none", path: "/data", file: "preview.db", roles: "single" },
        undefined,
      ),
    ).toEqual({
      ok: false,
      issue: { code: "db_roles_requires_provider", provider: "none" },
    });
    expect(
      dbRolesIssueMessage({ code: "db_roles_requires_provider", provider: "sqlite" }),
    ).toBe('db.roles requires db.provider postgres (got "sqlite")');
  });

  test("no explicit roles on sqlite or none resolves single", () => {
    expect(
      resolveDbRoles(
        { provider: "sqlite", path: "/data", file: "preview.db" },
        undefined,
      ),
    ).toEqual({ ok: true, value: "single" });
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

  test("requiresDatabase is false only for none", () => {
    expect(requiresDatabase("postgres")).toBe(true);
    expect(requiresDatabase("sqlite")).toBe(true);
    expect(requiresDatabase("none")).toBe(false);
  });
});
