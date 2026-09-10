import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistAdminTokenFile,
  resolveAdminTokenPath,
} from "./admin-token-file.ts";

describe("resolveAdminTokenPath", () => {
  test("places admin-token beside the state DB", () => {
    expect(resolveAdminTokenPath("/data/sprout.db")).toBe("/data/admin-token");
    expect(resolveAdminTokenPath("sprout.db")).toBe("admin-token");
  });

  test("SPROUT_ADMIN_TOKEN_PATH overrides", () => {
    const prev = process.env.SPROUT_ADMIN_TOKEN_PATH;
    process.env.SPROUT_ADMIN_TOKEN_PATH = "/custom/token";
    try {
      expect(resolveAdminTokenPath("/data/sprout.db")).toBe("/custom/token");
    } finally {
      if (prev === undefined) delete process.env.SPROUT_ADMIN_TOKEN_PATH;
      else process.env.SPROUT_ADMIN_TOKEN_PATH = prev;
    }
  });
});

describe("persistAdminTokenFile", () => {
  test("creates token file with mode 0600 under permissive umask", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sprout-admin-token-"));
    const path = join(dir, "admin-token");
    const prevUmask = process.umask(0o000);
    try {
      await persistAdminTokenFile("sprout_secret", path);
      expect((await readFile(path, "utf8")).trim()).toBe("sprout_secret");
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      process.umask(prevUmask);
    }
  });

  test("overwrites an existing file atomically with mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sprout-admin-token-"));
    const path = join(dir, "admin-token");
    await Bun.write(path, "old\n");
    await persistAdminTokenFile("new-secret", path);
    expect((await readFile(path, "utf8")).trim()).toBe("new-secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
