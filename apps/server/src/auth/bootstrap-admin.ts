import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { StateDb } from "../infrastructure/db/client.ts";
import {
  persistAdminTokenFile,
  resolveAdminTokenPath,
} from "./admin-token-file.ts";
import { ensureAdminToken } from "./store.ts";

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
    await access(path, constants.R_OK);
    const text = (await Bun.file(path).text()).trim();
    if (!text) throw new Error("empty");
  } catch {
    throw new Error(
      `Admin token exists in the control-plane DB but ${path} is missing or empty. Set SPROUT_ADMIN_TOKEN or restore the file.`,
    );
  }
}
