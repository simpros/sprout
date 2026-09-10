import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { ensureDatabase } from "./catalog.ts";
import { assertSafeRole, ensureLoginRole } from "./ensure-role.ts";
import { dockerAvailable, startTempPostgres } from "./postgres-it.ts";
import {
  deriveRestrictedPassword,
  dropRestrictedRole,
  ensureRestrictedRole,
  restrictedRoleName,
} from "./restricted-role.ts";

const hasDocker = await dockerAvailable();

describe("restrictedRoleName / deriveRestrictedPassword", () => {
  test("names the companion as <dbName>_app", () => {
    expect(restrictedRoleName("sprout_myapp_pr42")).toBe(
      "sprout_myapp_pr42_app",
    );
  });

  test("password is deterministic for the same owner secret + db", () => {
    const a = deriveRestrictedPassword("sekrit", "sprout_myapp_pr1");
    const b = deriveRestrictedPassword("sekrit", "sprout_myapp_pr1");
    const c = deriveRestrictedPassword("sekrit", "sprout_myapp_pr2");
    const d = deriveRestrictedPassword("other", "sprout_myapp_pr1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.length).toBeGreaterThan(20);
  });

  test("SAFE_ROLE rejects unsafe db identifiers", () => {
    expect(() => assertSafeRole("bad-name")).toThrow(/unsafe/);
    expect(() => assertSafeRole("sprout_rr_pr1")).not.toThrow();
  });
});

describe.skipIf(!hasDocker)("ensureRestrictedRole (postgres)", () => {
  const owner = "sprout_preview_rr";
  const ownerPassword = "owner-secret";
  const dbName = "sprout_rr_pr1";
  let adminUrl = "";
  let hostPort = 0;
  let stop: (() => Promise<void>) | undefined;
  let admin: SQL;

  beforeAll(async () => {
    const pg = await startTempPostgres(`sprout-restricted-role-${process.pid}`);
    adminUrl = pg.adminUrl;
    hostPort = pg.hostPort;
    stop = pg.stop;
    admin = new SQL(adminUrl);
    await ensureLoginRole(admin, owner, ownerPassword);
    await ensureDatabase(admin, { name: dbName, owner });
  });

  afterAll(async () => {
    await admin?.close();
    await stop?.();
  });

  test("creates non-owner LOGIN with CONNECT and authenticates", async () => {
    await ensureRestrictedRole(admin, {
      dbName,
      ownerPassword,
      adminUrl,
    });
    const role = restrictedRoleName(dbName);
    const password = deriveRestrictedPassword(ownerPassword, dbName);
    expect(role).toBe("sprout_rr_pr1_app");

    const restricted = new SQL(
      `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${dbName}`,
    );
    await restricted`SELECT 1`;

    const ownerCheck = await admin`
      SELECT pg_catalog.pg_get_userbyid(d.datdba) AS owner
      FROM pg_catalog.pg_database d
      WHERE d.datname = ${dbName}
    `;
    expect(ownerCheck[0]?.owner).toBe(owner);
    expect(ownerCheck[0]?.owner).not.toBe(role);

    await restricted.close();
  }, 15_000);

  test("ensure is idempotent (re-sync password)", async () => {
    await ensureRestrictedRole(admin, {
      dbName,
      ownerPassword,
      adminUrl,
    });
    await ensureRestrictedRole(admin, {
      dbName,
      ownerPassword,
      adminUrl,
    });

    const role = restrictedRoleName(dbName);
    const password = deriveRestrictedPassword(ownerPassword, dbName);
    const restricted = new SQL(
      `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${dbName}`,
    );
    await restricted`SELECT 1`;
    await restricted.close();
  });

  test("dropRestrictedRole removes the companion after DROP DATABASE", async () => {
    await ensureRestrictedRole(admin, {
      dbName,
      ownerPassword,
      adminUrl,
    });
    const role = restrictedRoleName(dbName);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await dropRestrictedRole(admin, dbName);

    const roles = await admin`
      SELECT 1 AS ok FROM pg_catalog.pg_roles WHERE rolname = ${role}
    `;
    expect(roles).toHaveLength(0);
  });

  test("refuses unsafe dbName before DDL", async () => {
    await expect(
      ensureRestrictedRole(admin, {
        dbName: "bad;drop",
        ownerPassword,
        adminUrl,
      }),
    ).rejects.toThrow(/unsafe/);
  });
});
