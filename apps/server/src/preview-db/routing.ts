import { normalizeDbSpec, type DbSpec } from "@sprout/preview-env";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export type RoutingPreviewDbOptions = {
  postgres?: PreviewDb;
  sqlite?: PreviewDb;
};

function missingBackend(provider: string): Error {
  return new Error(`preview database provider not configured: ${provider}`);
}

export function createRoutingPreviewDb(
  options: RoutingPreviewDbOptions,
): PreviewDb {
  const { postgres, sqlite } = options;

  function forCreate(db: DbSpec | undefined): PreviewDb {
    const provider = normalizeDbSpec(db).provider;
    if (provider === "sqlite") {
      if (!sqlite) throw missingBackend("sqlite");
      return sqlite;
    }
    if (!postgres) throw missingBackend("postgres");
    return postgres;
  }

  return {
    async createDatabase(dbName, db) {
      await forCreate(db).createDatabase(dbName, db);
    },

    async dropDatabase(dbName) {
      const failures: unknown[] = [];
      if (postgres) {
        try {
          await postgres.dropDatabase(dbName);
        } catch (err) {
          failures.push(err);
        }
      }
      if (sqlite) {
        try {
          await sqlite.dropDatabase(dbName);
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw failures[0];
    },

    async listPreviewDatabases() {
      const out: CatalogDatabase[] = [];
      if (postgres) out.push(...(await postgres.listPreviewDatabases()));
      if (sqlite) out.push(...(await sqlite.listPreviewDatabases()));
      return out;
    },

    async ensurePreviewRole() {
      if (postgres) await postgres.ensurePreviewRole();
    },

    async ping() {
      if (postgres) await postgres.ping();
      if (sqlite) await sqlite.ping();
    },
  };
}
