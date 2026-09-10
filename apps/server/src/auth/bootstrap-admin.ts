import type { StateDb } from "../infrastructure/db/client.ts";
import {
  persistAdminTokenFile,
  resolveAdminTokenPath,
} from "./admin-token-file.ts";
import { ensureAdminToken, findActive } from "./store.ts";

/**
 * Boot seam: ensure an admin hash in SQLite, keep the raw bearer on disk for
 * in-container CLI fallback, and log once when auto-generating.
 */
export async function bootstrapAdminToken(
  db: StateDb,
  configured?: string,
): Promise<void> {
  const result = await ensureAdminToken(db, configured);

  if (result.status === "pinned" || result.status === "generated") {
    await persistAdminTokenFile(result.raw);
    if (result.status === "generated") {
      console.warn(
        "SPROUT_ADMIN_TOKEN not set; generated bootstrap admin token (store securely):",
        result.raw,
      );
    }
    return;
  }

  // Hashed-only admin already in DB — raw must still be on disk for CLI fallback.
  const path = resolveAdminTokenPath();
  try {
    const text = (await Bun.file(path).text()).trim();
    if (!text) throw new Error("empty");
    const auth = await findActive(db, text);
    if (auth?.scope !== "admin") throw new Error("not-admin");
  } catch {
    throw new Error(
      `Admin token exists in the control-plane DB but ${path} is missing, empty, or does not match an active admin token. Set SPROUT_ADMIN_TOKEN or restore the file.`,
    );
  }
}
