import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createPostgresPreviewDb } from "./postgres.ts";

describe("createPostgresPreviewDb", () => {
  test("rejects mixed-case preview roles (unquoted identifiers)", () => {
    expect(() =>
      createPostgresPreviewDb({
        url: "postgres://localhost/postgres",
        previewRole: "Pb_Preview",
        previewPassword: "secret",
      }),
    ).toThrow(/unsafe preview role/);
  });

  test("accepts lowercase preview roles", () => {
    expect(() =>
      createPostgresPreviewDb({
        url: "postgres://localhost/postgres",
        previewRole: "sprout_preview",
        previewPassword: "secret",
      }),
    ).not.toThrow();
  });
});

const dockerAvailable = await (async () => {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerAvailable)("ensurePreviewRole (postgres)", () => {
  const container = `sprout-ensure-role-${process.pid}`;
  const adminPassword = "admin-secret";
  const role = "sprout_preview_it";
  let adminUrl = "";
  let hostPort = 0;

  beforeAll(async () => {
    const rm = Bun.spawn(["docker", "rm", "-f", container], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await rm.exited;

    const run = Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "-e",
        "POSTGRES_PASSWORD=" + adminPassword,
        "-p",
        "127.0.0.1::5432",
        "postgres:16-alpine",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(run.stdout).text();
    const err = await new Response(run.stderr).text();
    if ((await run.exited) !== 0) {
      throw new Error(`docker run failed: ${err || out}`);
    }

    const portProc = Bun.spawn(
      ["docker", "port", container, "5432/tcp"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const portOut = (await new Response(portProc.stdout).text()).trim();
    if ((await portProc.exited) !== 0) {
      throw new Error(`docker port failed: ${portOut}`);
    }
    // e.g. 127.0.0.1:32768
    hostPort = Number(portOut.split(":").at(-1));
    adminUrl = `postgres://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${hostPort}/postgres`;

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const sql = new SQL(adminUrl);
        await sql`SELECT 1`;
        await sql.close();
        return;
      } catch {
        await Bun.sleep(250);
      }
    }
    throw new Error("postgres container did not become ready");
  });

  afterAll(async () => {
    const rm = Bun.spawn(["docker", "rm", "-f", container], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await rm.exited;
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
      /CREATEROLE|role-creation|cannot ensure preview role/i,
    );
  });
});
