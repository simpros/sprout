import { parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export type FakePreviewDb = PreviewDb & {
  created: string[];
  dropped: string[];
  restrictedEnsured: string[];
};

export function createFakePreviewDb(): FakePreviewDb {
  const created: string[] = [];
  const dropped: string[] = [];
  const restrictedEnsured: string[] = [];

  return {
    created,
    dropped,
    restrictedEnsured,
    async createDatabase(dbName) {
      const live = new Set(created);
      for (const name of dropped) live.delete(name);
      if (!live.has(dbName)) {
        created.push(dbName);
      }
      // Companion ensure runs on every createDatabase call (incl. sync re-ensure).
      restrictedEnsured.push(dbName);
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
    async ensurePreviewRole() {},
    async ping() {},
  };
}
