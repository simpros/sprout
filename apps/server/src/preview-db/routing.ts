import type { DbProvider } from "@sprout/preview-env";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export type RoutingPreviewDbOptions = {
  postgres?: PreviewDb;
  sqlite?: PreviewDb;
};

/**
 * Selector over the configured backends plus the merged read view.
 * Adapters stay provider-agnostic: create picks a backend up front, and
 * teardown reads the stored provider off the preview row, so drops route
 * deterministically. Only row-less sweep orphans fall back to broadcast.
 */
export type PreviewDbRouter = {
  forCreate(provider: DbProvider): PreviewDb;
  forDrop(provider: DbProvider | undefined): Pick<PreviewDb, "dropDatabase">;
  listPreviewDatabases(): Promise<CatalogDatabase[]>;
  ensurePreviewRole(): Promise<void>;
  ping(): Promise<void>;
};

function missingBackend(provider: string): Error {
  return new Error(`preview database provider not configured: ${provider}`);
}

function backendFor(
  options: RoutingPreviewDbOptions,
  provider: DbProvider,
): PreviewDb {
  if (provider === "none") {
    throw new Error("provider none has no database backend: must not provision");
  }
  if (provider === "sqlite") {
    if (!options.sqlite) throw missingBackend("sqlite");
    return options.sqlite;
  }
  if (!options.postgres) throw missingBackend("postgres");
  return options.postgres;
}

/** None previews hold no database resource, so drops are a no-op. */
function noneDrop(): Pick<PreviewDb, "dropDatabase"> {
  return { dropDatabase: async () => {} };
}

export function createRoutingPreviewDb(
  options: RoutingPreviewDbOptions,
): PreviewDbRouter {
  const { postgres, sqlite } = options;

  /** Row-less sweep path: both backends are missing-tolerant, so a throw is real. */
  async function broadcastDrop(dbName: string): Promise<void> {
    const results = await Promise.allSettled([
      ...(postgres ? [postgres.dropDatabase(dbName)] : []),
      ...(sqlite ? [sqlite.dropDatabase(dbName)] : []),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures);
  }

  return {
    forCreate(provider) {
      return backendFor(options, provider);
    },

    forDrop(provider) {
      if (provider === undefined) return { dropDatabase: broadcastDrop };
      if (provider === "none") return noneDrop();
      const backend = backendFor(options, provider);
      return { dropDatabase: (dbName) => backend.dropDatabase(dbName) };
    },

    async listPreviewDatabases() {
      const seen = new Set<string>();
      const out: CatalogDatabase[] = [];
      if (postgres) out.push(...(await postgres.listPreviewDatabases()));
      if (sqlite) out.push(...(await sqlite.listPreviewDatabases()));
      // Both backends share one dbName space; a collision is one resource.
      return out.filter((entry) => {
        if (seen.has(entry.dbName)) return false;
        seen.add(entry.dbName);
        return true;
      });
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
