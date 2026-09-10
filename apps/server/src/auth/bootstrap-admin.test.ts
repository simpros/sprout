import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "../http/test-helpers.ts";
import { bootstrapAdminToken } from "./bootstrap-admin.ts";
import { ensureAdminToken } from "./store.ts";

describe("bootstrapAdminToken", () => {
  let testDb: TestDb | undefined;
  let prevPath: string | undefined;

  afterEach(async () => {
    if (prevPath === undefined) delete process.env.SPROUT_ADMIN_TOKEN_PATH;
    else process.env.SPROUT_ADMIN_TOKEN_PATH = prevPath;
    prevPath = undefined;
    if (testDb) await testDb.cleanup();
    testDb = undefined;
  });

  async function withTokenPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sprout-bootstrap-admin-"));
    const path = join(dir, "admin-token");
    prevPath = process.env.SPROUT_ADMIN_TOKEN_PATH;
    process.env.SPROUT_ADMIN_TOKEN_PATH = path;
    return path;
  }

  test("pins configured token and writes the file", async () => {
    testDb = await createTestDb();
    const path = await withTokenPath();
    await bootstrapAdminToken(testDb.db, "pinned-admin");
    expect((await readFile(path, "utf8")).trim()).toBe("pinned-admin");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("generates once, persists, and warns", async () => {
    testDb = await createTestDb();
    const path = await withTokenPath();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      await bootstrapAdminToken(testDb.db);
    } finally {
      console.warn = original;
    }
    const raw = (await readFile(path, "utf8")).trim();
    expect(raw.startsWith("sprout_")).toBe(true);
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]?.[1])).toBe(raw);

    // Later boot with hashed-only admin: file must still be present.
    await bootstrapAdminToken(testDb.db);
    expect((await readFile(path, "utf8")).trim()).toBe(raw);
  });

  test("fails when existing admin has no readable token file", async () => {
    testDb = await createTestDb();
    const path = await withTokenPath();
    await ensureAdminToken(testDb.db); // generate hash only; no file
    await expect(bootstrapAdminToken(testDb.db)).rejects.toThrow(
      `Admin token exists in the control-plane DB but ${path} is missing, empty, or does not match an active admin token`,
    );
  });

  test("fails when token file does not match an active admin", async () => {
    testDb = await createTestDb();
    const path = await withTokenPath();
    await bootstrapAdminToken(testDb.db, "pinned-admin");
    await Bun.write(path, "not-the-token\n");
    await expect(bootstrapAdminToken(testDb.db)).rejects.toThrow(
      `Admin token exists in the control-plane DB but ${path} is missing, empty, or does not match an active admin token`,
    );
  });

  test("rewrites file every boot when pinned", async () => {
    testDb = await createTestDb();
    const path = await withTokenPath();
    await bootstrapAdminToken(testDb.db, "pinned-admin");
    await Bun.write(path, "stale\n");
    await bootstrapAdminToken(testDb.db, "pinned-admin");
    expect((await readFile(path, "utf8")).trim()).toBe("pinned-admin");
  });
});
