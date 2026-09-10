import type { SQL } from "bun";

/** Unquoted Postgres identifiers fold to lowercase — require lowercase roles. */
export const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

export function assertSafeRole(role: string): void {
  if (!SAFE_ROLE.test(role)) {
    throw new Error(`refusing unsafe preview role name: ${role}`);
  }
}

function pgErrorMatches(
  err: unknown,
  opts: { codes: string[]; messageRe?: RegExp },
): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  if (opts.codes.includes(code)) return true;
  if (!opts.messageRe) return false;
  const message = "message" in err ? String(err.message) : String(err);
  return opts.messageRe.test(message);
}

export function isDuplicateRole(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42710"],
    messageRe: /already exists/i,
  });
}

function isInsufficientPrivilege(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42501"],
    messageRe: /permission denied|must be superuser|must have createrole/i,
  });
}

function roleEnsureError(role: string, err: unknown): Error {
  const detail =
    err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  if (isInsufficientPrivilege(err)) {
    return new Error(
      `cannot ensure preview role "${role}": admin connection lacks CREATEROLE (or superuser) privilege: ${detail}`,
    );
  }
  return new Error(`cannot ensure preview role "${role}": ${detail}`);
}

/** Build CREATE/ALTER via Postgres format(%I/%L) so passwords stay escaped. */
async function roleDdl(
  sql: SQL,
  role: string,
  password: string,
  kind: "create" | "alter",
): Promise<string> {
  const template =
    kind === "create"
      ? "CREATE ROLE %I LOGIN PASSWORD %L"
      : "ALTER ROLE %I LOGIN PASSWORD %L";
  const rows = await sql<{ stmt: string }[]>`
    SELECT format(
      ${template},
      ${role}::text,
      ${password}::text
    ) AS stmt
  `;
  const stmt = rows[0]?.stmt;
  if (!stmt) {
    throw new Error("role ensure produced no SQL statement");
  }
  return stmt;
}

/**
 * Create or sync a LOGIN role password via the admin connection.
 * Same algorithm as gateway boot (#71): CREATE if missing, else ALTER.
 */
export async function ensureLoginRole(
  sql: SQL,
  role: string,
  password: string,
): Promise<void> {
  assertSafeRole(role);
  try {
    const existing = await sql`
      SELECT 1 AS ok
      FROM pg_catalog.pg_roles
      WHERE rolname = ${role}
      LIMIT 1
    `;
    if (existing.length > 0) {
      await sql.unsafe(await roleDdl(sql, role, password, "alter"));
      return;
    }
    try {
      await sql.unsafe(await roleDdl(sql, role, password, "create"));
    } catch (err) {
      // Concurrent ensure: another caller created the role between SELECT and CREATE.
      if (!isDuplicateRole(err)) throw err;
      await sql.unsafe(await roleDdl(sql, role, password, "alter"));
    }
  } catch (err) {
    throw roleEnsureError(role, err);
  }
}
