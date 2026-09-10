import { SQL } from "bun";
import {
  assertSafeRole,
  dropDatabase,
  dropRestrictedRole,
  ensureDatabase,
  ensureLoginRole,
  ensureRestrictedRole,
} from "@sprout/preview-db";
import { assertPreviewDbName, parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export type PostgresPreviewDbOptions = {
  url: string;
  previewRole: string;
  previewPassword: string;
};

export function createPostgresPreviewDb(
  options: PostgresPreviewDbOptions,
): PreviewDb {
  assertSafeRole(options.previewRole);
  const sql = new SQL(options.url);
  const previewRole = options.previewRole;
  const previewPassword = options.previewPassword;
  const adminUrl = options.url;

  /** Process-lifetime memo: password rotation is env change + restart. */
  let roleEnsured = false;
  let ensureInFlight: Promise<void> | undefined;

  async function ensurePreviewRole(): Promise<void> {
    if (roleEnsured) return;
    if (!ensureInFlight) {
      ensureInFlight = ensureLoginRole(sql, previewRole, previewPassword).then(
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

  async function ensureRestricted(
    dbName: string,
  ): Promise<{ role: string; password: string }> {
    assertPreviewDbName(dbName);
    return ensureRestrictedRole(sql, {
      dbName,
      ownerPassword: previewPassword,
      adminUrl,
    });
  }

  return {
    async createDatabase(dbName) {
      assertPreviewDbName(dbName);
      // Defensive if boot skipped ensure; memoized after first success (no hot-path ALTER).
      await ensurePreviewRole();
      await ensureDatabase(sql, { name: dbName, owner: previewRole });
      await ensureRestricted(dbName);
    },

    async dropDatabase(dbName) {
      assertPreviewDbName(dbName);
      await dropDatabase(sql, dbName);
      await dropRestrictedRole(sql, dbName);
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

    ensureRestrictedRole: ensureRestricted,

    async ping() {
      await sql`SELECT 1`;
    },
  };
}
