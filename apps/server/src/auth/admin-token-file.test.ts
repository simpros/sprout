import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
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
  test("writes token with mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sprout-admin-token-"));
    // Ensure restrictive umask does not hide chmod intent on the assertion.
    await chmod(dir, 0o700);
    const path = join(dir, "admin-token");
    await persistAdminTokenFile("sprout_secret", path);
    expect((await readFile(path, "utf8")).trim()).toBe("sprout_secret");
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
