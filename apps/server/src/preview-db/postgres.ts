import { SQL } from "bun";
import { assertPreviewDbName, parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

/** Unquoted Postgres identifiers fold to lowercase — require lowercase roles. */
const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

export type PostgresPreviewDbOptions = {
  url: string;
  previewRole: string;
  previewPassword: string;
};

function assertSafeRole(role: string): void {
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

function isDuplicateDatabase(err: unknown): boolean {
  return pgErrorMatches(err, {
    codes: ["42P04"],
    messageRe: /already exists/i,
  });
}

function isDuplicateRole(err: unknown): boolean {
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

export function createPostgresPreviewDb(
  options: PostgresPreviewDbOptions,
): PreviewDb {
  assertSafeRole(options.previewRole);
  const sql = new SQL(options.url);
  const previewRole = options.previewRole;
  const previewPassword = options.previewPassword;

  /** Process-lifetime memo: password rotation is env change + restart. */
  let roleEnsured = false;
  let ensureInFlight: Promise<void> | undefined;

  /** Build CREATE/ALTER via Postgres format(%I/%L) so passwords stay escaped. */
  async function roleDdl(kind: "create" | "alter"): Promise<string> {
    const template =
      kind === "create"
        ? "CREATE ROLE %I LOGIN PASSWORD %L"
        : "ALTER ROLE %I LOGIN PASSWORD %L";
    const rows = await sql<{ stmt: string }[]>`
      SELECT format(
        ${template},
        ${previewRole}::text,
        ${previewPassword}::text
      ) AS stmt
    `;
    const stmt = rows[0]?.stmt;
    if (!stmt) {
      throw new Error("role ensure produced no SQL statement");
    }
    return stmt;
  }

  async function ensurePreviewRoleOnce(): Promise<void> {
    try {
      const existing = await sql`
        SELECT 1 AS ok
        FROM pg_catalog.pg_roles
        WHERE rolname = ${previewRole}
        LIMIT 1
      `;
      if (existing.length > 0) {
        await sql.unsafe(await roleDdl("alter"));
        return;
      }
      try {
        await sql.unsafe(await roleDdl("create"));
      } catch (err) {
        // Concurrent ensure: another caller created the role between SELECT and CREATE.
        if (!isDuplicateRole(err)) throw err;
        await sql.unsafe(await roleDdl("alter"));
      }
    } catch (err) {
      throw roleEnsureError(previewRole, err);
    }
  }

  async function ensurePreviewRole(): Promise<void> {
    if (roleEnsured) return;
    if (!ensureInFlight) {
      ensureInFlight = ensurePreviewRoleOnce().then(
        () => {
          roleEnsured = true;
        },
        (err) => {
          ensureInFlight = undefined;
          throw err;
        },
      );
    }
    await ensureInFlight;
  }

  return {
    async createDatabase(dbName) {
      assertPreviewDbName(dbName);
      // Defensive if boot skipped ensure; memoized after first success (no hot-path ALTER).
      await ensurePreviewRole();
      const existing = await sql`
        SELECT 1 AS ok FROM pg_database WHERE datname = ${dbName} LIMIT 1
      `;
      if (existing.length > 0) return;
      // Identifiers validated above; Bun.sql cannot parameterize DDL identifiers.
      try {
        await sql.unsafe(
          `CREATE DATABASE ${dbName} OWNER ${previewRole}`,
        );
      } catch (err) {
        // Concurrent deploy: another request created the DB between SELECT and CREATE.
        if (isDuplicateDatabase(err)) return;
        throw err;
      }
    },

    async dropDatabase(dbName) {
      assertPreviewDbName(dbName);
      await sql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${dbName} AND pid <> pg_backend_pid()
      `;
      await sql.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    },

    async listPreviewDatabases() {
      const rows = await sql<{ datname: string }[]>`
        SELECT datname FROM pg_database
        WHERE datname LIKE 'sprout_%'
      `;
      const out: CatalogDatabase[] = [];
      for (const row of rows) {
        const parsed = parsePreviewDatabaseName(row.datname);
        if (!parsed) continue;
        out.push({
          dbName: row.datname,
          slug: parsed.slug,
          prId: parsed.prId,
        });
      }
      return out;
    },

    ensurePreviewRole,

    async ping() {
      await sql`SELECT 1`;
    },
  };
}
