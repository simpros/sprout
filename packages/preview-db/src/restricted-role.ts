import { createHmac } from "node:crypto";
import { SQL } from "bun";
import { assertSafeRole, ensureLoginRole } from "./ensure-role.ts";

/** Postgres truncates unquoted identifiers past 63 chars, risking collisions. */
export const PG_IDENT_MAX = 63;

export function restrictedRoleName(dbName: string): string {
  const role = `${dbName}_app`;
  if (role.length > PG_IDENT_MAX) {
    throw new Error(
      `companion role name exceeds Postgres identifier limit (${PG_IDENT_MAX}): ${role}`,
    );
  }
  return role;
}

export function deriveRestrictedPassword(
  ownerPassword: string,
  dbName: string,
): string {
  return createHmac("sha256", ownerPassword)
    .update(`sprout-restricted:${dbName}`)
    .digest("base64url");
}

export async function ensureRestrictedRole(
  sql: SQL,
  opts: { dbName: string; ownerPassword: string; adminUrl: string },
): Promise<void> {
  assertSafeRole(opts.dbName);
  const role = restrictedRoleName(opts.dbName);
  assertSafeRole(role);
  const password = deriveRestrictedPassword(opts.ownerPassword, opts.dbName);

  await ensureLoginRole(sql, role, password);

  await sql.unsafe(
    `GRANT CONNECT ON DATABASE ${opts.dbName} TO ${role}`,
  );

  const dbSql = new SQL(databaseUrlFor(opts.adminUrl, opts.dbName));
  try {
    await dbSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  } finally {
    await dbSql.close();
  }
}

/** Caller must DROP DATABASE before dropping the companion role. */
export async function dropRestrictedRole(
  sql: SQL,
  dbName: string,
): Promise<void> {
  assertSafeRole(dbName);
  const role = `${dbName}_app`;
  if (role.length > PG_IDENT_MAX) return;
  assertSafeRole(role);
  await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
}

function databaseUrlFor(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}
