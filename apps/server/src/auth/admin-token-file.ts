import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDbPath } from "../infrastructure/db/client.ts";

/**
 * Path for the raw bootstrap admin token (owner-only file).
 * Defaults beside the control-plane SQLite DB (`…/admin-token`).
 */
export function resolveAdminTokenPath(
  stateDbPath: string = resolveStateDbPath(),
): string {
  const override = process.env.SPROUT_ADMIN_TOKEN_PATH?.trim();
  if (override) return override;
  return join(dirname(stateDbPath), "admin-token");
}

/** Write the raw admin bearer for in-container CLI fallback; mode 0600. */
export async function persistAdminTokenFile(
  raw: string,
  path: string = resolveAdminTokenPath(),
): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("persistAdminTokenFile: empty token");
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${trimmed}\n`);
  await chmod(path, 0o600);
}
