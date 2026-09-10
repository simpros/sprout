import { createHmac } from "node:crypto";
import { SQL } from "bun";
import { assertSafeRole, ensureLoginRole } from "./ensure-role.ts";

/** Companion LOGIN role for one preview DB: `<dbName>_app`. */
export function restrictedRoleName(dbName: string): string {
  return `${dbName}_app`;
}

/**
 * Deterministic companion password from the owner preview password + db name.
 * Stable across gateway restarts without persisting secrets in SQLite.
 */
export function deriveRestrictedPassword(
  ownerPassword: string,
  dbName: string,
): string {
  return createHmac("sha256", ownerPassword)
    .update(`sprout-restricted:${dbName}`)
    .digest("base64url");
}

export type RestrictedRoleCredentials = {
  role: string;
  password: string;
};

/**
 * Ensure a per-DB restricted LOGIN role, GRANT CONNECT + schema USAGE.
 * Does not own the database (owner stays the static preview login).
 */
export async function ensureRestrictedRole(
  sql: SQL,
  opts: { dbName: string; ownerPassword: string; adminUrl: string },
): Promise<RestrictedRoleCredentials> {
  const role = restrictedRoleName(opts.dbName);
  assertSafeRole(role);
  const password = deriveRestrictedPassword(opts.ownerPassword, opts.dbName);

  await ensureLoginRole(sql, role, password);

  // Identifiers validated (preview grammar + SAFE_ROLE).
  await sql.unsafe(
    `GRANT CONNECT ON DATABASE ${opts.dbName} TO ${role}`,
  );

  const dbSql = new SQL(databaseUrlFor(opts.adminUrl, opts.dbName));
  try {
    await dbSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  } finally {
    await dbSql.close();
  }

  return { role, password };
}

/** DROP ROLE IF EXISTS for the companion; caller must DROP DATABASE first. */
export async function dropRestrictedRole(
  sql: SQL,
  dbName: string,
): Promise<void> {
  const role = restrictedRoleName(dbName);
  assertSafeRole(role);
  await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
}

function databaseUrlFor(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
