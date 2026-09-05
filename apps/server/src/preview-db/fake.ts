import { parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export type FakePreviewDb = PreviewDb & {
  created: string[];
  dropped: string[];
};

export function createFakePreviewDb(): FakePreviewDb {
  const created: string[] = [];
  const dropped: string[] = [];
  return {
    created,
    dropped,
    async createDatabase(dbName) {
      created.push(dbName);
    },
    async dropDatabase(dbName) {
      dropped.push(dbName);
    },
    async listPreviewDatabases() {
      const live = new Set(created);
      for (const name of dropped) live.delete(name);
      const out: CatalogDatabase[] = [];
      for (const dbName of live) {
        const parsed = parsePreviewDatabaseName(dbName);
        if (!parsed) continue;
        out.push({ dbName, slug: parsed.slug, prId: parsed.prId });
      }
      return out;
    },
    async ping() {},
  };
}
