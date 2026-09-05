import { SQL } from "bun";
import { assertPreviewDbName, parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

/** Unquoted Postgres identifiers fold to lowercase — require lowercase roles. */
const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

export type PostgresPreviewDbOptions = {
  url: string;
  previewRole: string;
};

function assertSafeRole(role: string): void {
  if (!SAFE_ROLE.test(role)) {
    throw new Error(`refusing unsafe preview role name: ${role}`);
  }
}

function isDuplicateDatabase(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String(err.code) : "";
  if (code === "42P04") return true;
  const message = "message" in err ? String(err.message) : String(err);
  return /already exists/i.test(message);
}

export function createPostgresPreviewDb(
  options: PostgresPreviewDbOptions,
): PreviewDb {
  assertSafeRole(options.previewRole);
  const sql = new SQL(options.url);
  const previewRole = options.previewRole;

  return {
    async createDatabase(dbName) {
      assertPreviewDbName(dbName);
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
        WHERE datname LIKE 'prev_%'
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

    async ping() {
      await sql`SELECT 1`;
    },
  };
}
