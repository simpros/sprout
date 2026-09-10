import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDbPath } from "../infrastructure/db/client.ts";

/**
 * Path for the raw bootstrap admin token (owner-only file).
 * Prefer `SPROUT_ADMIN_TOKEN_PATH`; else beside the control-plane SQLite DB.
 */
export function resolveAdminTokenPath(
  stateDbPath: string = resolveStateDbPath(),
): string {
  const override = process.env.SPROUT_ADMIN_TOKEN_PATH?.trim();
  if (override) return override;
  return join(dirname(stateDbPath), "admin-token");
}

/**
 * Write the raw admin bearer for in-container CLI fallback.
 * Creates the file with mode 0600 (temp + rename); no post-write chmod window.
 */
export async function persistAdminTokenFile(
  raw: string,
  path: string = resolveAdminTokenPath(),
): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("persistAdminTokenFile: empty token");
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(tmp, "w", 0o600);
    // fchmod after create so umask cannot leave the secret group/world-readable.
    await handle.chmod(0o600);
    await handle.writeFile(`${trimmed}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
