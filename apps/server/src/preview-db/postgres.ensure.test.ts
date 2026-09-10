import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { dockerAvailable, startTempPostgres } from "@sprout/preview-db/testing";
import { createPostgresPreviewDb } from "./postgres.ts";

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("ensurePreviewRole (postgres)", () => {
  const role = "sprout_preview_it";
  let adminUrl = "";
  let hostPort = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const pg = await startTempPostgres(`sprout-ensure-role-${process.pid}`);
    adminUrl = pg.adminUrl;
    hostPort = pg.hostPort;
    stop = pg.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  test("creates missing preview role and authenticates with the password", async () => {
    const password = "first-password";
    const db = createPostgresPreviewDb({
      url: adminUrl,
      previewRole: role,
      previewPassword: password,
    });
    await db.ensurePreviewRole();

    const preview = new SQL(
      `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/postgres`,
    );
    await preview`SELECT 1`;
    await preview.close();
  });

  test("syncs password on existing role (ALTER)", async () => {
    const admin = new SQL(adminUrl);
    const before = await admin<{ rolpassword: string }[]>`
      SELECT rolpassword FROM pg_authid WHERE rolname = ${role}
    `;
    expect(before[0]?.rolpassword).toBeDefined();

    const rotated = "rotated-password";
    const db = createPostgresPreviewDb({
      url: adminUrl,
      previewRole: role,
      previewPassword: rotated,
    });
    await db.ensurePreviewRole();

    const after = await admin<{ rolpassword: string }[]>`
      SELECT rolpassword FROM pg_authid WHERE rolname = ${role}
    `;
    expect(after[0]?.rolpassword).toBeDefined();
    expect(after[0]!.rolpassword).not.toBe(before[0]!.rolpassword);
    await admin.close();

    const withNew = new SQL(
      `postgres://${role}:${encodeURIComponent(rotated)}@127.0.0.1:${hostPort}/postgres`,
    );
    await withNew`SELECT 1`;
    await withNew.close();
  });

  test("createDatabase ensures role before OWNER grant", async () => {
    const dbName = "sprout_ensure_pr1";
    const password = "owner-password";
    const db = createPostgresPreviewDb({
      url: adminUrl,
      previewRole: "sprout_owner_it",
      previewPassword: password,
    });
    await db.createDatabase(dbName);

    const preview = new SQL(
      `postgres://sprout_owner_it:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${dbName}`,
    );
    await preview`SELECT 1`;
    await preview.close();

    await db.dropDatabase(dbName);
  });

  test("memoized ensure does not re-ALTER on subsequent calls", async () => {
    const password = "memo-password";
    const db = createPostgresPreviewDb({
      url: adminUrl,
      previewRole: "sprout_memo_it",
      previewPassword: password,
    });
    await db.ensurePreviewRole();

    const admin = new SQL(adminUrl);
    const before = await admin<{ rolpassword: string }[]>`
      SELECT rolpassword FROM pg_authid WHERE rolname = 'sprout_memo_it'
    `;
    expect(before[0]?.rolpassword).toBeDefined();

    await db.ensurePreviewRole();
    await db.createDatabase("sprout_memo_pr1");

    const after = await admin<{ rolpassword: string }[]>`
      SELECT rolpassword FROM pg_authid WHERE rolname = 'sprout_memo_it'
    `;
    expect(after[0]!.rolpassword).toBe(before[0]!.rolpassword);
    await admin.close();
    await db.dropDatabase("sprout_memo_pr1");
  });

  test("concurrent ensure on missing role succeeds for all callers", async () => {
    const password = "race-password";
    const db = createPostgresPreviewDb({
      url: adminUrl,
      previewRole: "sprout_race_it",
      previewPassword: password,
    });

    await Promise.all([
      db.ensurePreviewRole(),
      db.ensurePreviewRole(),
      db.ensurePreviewRole(),
    ]);

    const preview = new SQL(
      `postgres://sprout_race_it:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/postgres`,
    );
    await preview`SELECT 1`;
    await preview.close();
  });

  test("missing CREATEROLE surfaces a clear error", async () => {
    const admin = new SQL(adminUrl);
    await admin.unsafe(
      `CREATE ROLE limited_admin LOGIN PASSWORD 'limited' NOSUPERUSER NOCREATEROLE`,
    );
    await admin.close();

    const limitedUrl = `postgres://limited_admin:${encodeURIComponent("limited")}@127.0.0.1:${hostPort}/postgres`;
    const db = createPostgresPreviewDb({
      url: limitedUrl,
      previewRole: "should_not_exist",
      previewPassword: "x",
    });

    await expect(db.ensurePreviewRole()).rejects.toThrow(
      /cannot ensure preview role "should_not_exist": admin connection lacks CREATEROLE/,
    );
  });
});
