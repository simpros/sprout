import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Well-known default; compose/image set `SPROUT_ADMIN_TOKEN_PATH` explicitly. */
const DEFAULT_ADMIN_TOKEN_PATH = "admin-token";

/**
 * Path for the raw bootstrap admin token (owner-only file).
 * Same contract as the CLI: override or well-known default (not derived from DB path).
 */
export function resolveAdminTokenPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SPROUT_ADMIN_TOKEN_PATH?.trim() || DEFAULT_ADMIN_TOKEN_PATH;
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
