import { SQL } from "bun";
import { dropDatabase, ensureDatabase } from "./catalog.ts";
import { ensureLoginRole } from "./ensure-role.ts";
import { throwWorktreeInputError } from "./errors.ts";
import {
  assertWorktreeObjectName,
  normalizeWorktreeKey,
  worktreeObjectName,
} from "./worktree-names.ts";

function parseAdminUrl(adminUrl: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throwWorktreeInputError(
      "invalid_admin_url",
      adminUrl,
      `invalid adminUrl: ${adminUrl}`,
    );
  }
  const host = parsed.hostname;
  if (!host) {
    throwWorktreeInputError(
      "invalid_admin_url",
      adminUrl,
      `invalid adminUrl (missing host): ${adminUrl}`,
    );
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0) {
    throwWorktreeInputError(
      "invalid_admin_url",
      adminUrl,
      `invalid adminUrl port: ${adminUrl}`,
    );
  }
  return { host, port };
}

function resolveObjectName(rawKey: string): {
  worktreeKey: string;
  objectName: string;
} {
  const worktreeKey = normalizeWorktreeKey(rawKey);
  if (!worktreeKey) {
    throwWorktreeInputError(
      "invalid_worktree_key",
      rawKey,
      `invalid worktreeKey (empty after normalize): ${rawKey}`,
    );
  }
  const objectName = worktreeObjectName(worktreeKey);
  assertWorktreeObjectName(objectName);
  return { worktreeKey, objectName };
}

export type WorktreeConnection = {
  worktreeKey: string;
  /** Database and login role name (`sprout_wt_…`). */
  objectName: string;
  password: string;
  host: string;
  port: number;
  databaseUrl: string;
};

export type ProvisionWorktreeDbOptions = {
  adminUrl: string;
  worktreeKey: string;
  /**
   * When omitted, a random password is generated and synced.
   * Callers that want stable credentials across re-provision should pass the
   * existing password (e.g. from the env file).
   */
  password?: string;
};

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Idempotent ensure of worktree DB + LOGIN role (`sprout_wt_<key>`).
 * Reuses #71 ensure-role (CREATE or ALTER password).
 */
export async function provisionWorktreeDb(
  options: ProvisionWorktreeDbOptions,
): Promise<WorktreeConnection> {
  const { worktreeKey, objectName } = resolveObjectName(options.worktreeKey);
  const { host, port } = parseAdminUrl(options.adminUrl);
  const password = options.password ?? randomPassword();

  const sql = new SQL(options.adminUrl);
  try {
    await ensureLoginRole(sql, objectName, password);
    await ensureDatabase(sql, { name: objectName, owner: objectName });

    const databaseUrl =
      `postgres://${objectName}:${encodeURIComponent(password)}` +
      `@${host}:${port}/${objectName}`;

    return { worktreeKey, objectName, password, host, port, databaseUrl };
  } finally {
    await sql.close();
  }
}

export type DropWorktreeDbOptions = {
  adminUrl: string;
  worktreeKey: string;
};

export type DropWorktreeDbResult = {
  worktreeKey: string;
  objectName: string;
};

/**
 * Drop worktree DB + role. Touches only `sprout_wt_`-prefixed objects;
 * refuses anything else via assertWorktreeObjectName.
 */
export async function dropWorktreeDb(
  options: DropWorktreeDbOptions,
): Promise<DropWorktreeDbResult> {
  const { worktreeKey, objectName } = resolveObjectName(options.worktreeKey);
  // Defense in depth: never run DROP on a non-prefixed name.
  assertWorktreeObjectName(objectName);

  const sql = new SQL(options.adminUrl);
  try {
    await dropDatabase(sql, objectName);
    await sql.unsafe(`DROP ROLE IF EXISTS ${objectName}`);
    return { worktreeKey, objectName };
  } finally {
    await sql.close();
  }
}
