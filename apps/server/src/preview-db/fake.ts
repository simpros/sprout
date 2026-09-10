import { parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export type FakePreviewDb = PreviewDb & {
  created: string[];
  dropped: string[];
  restrictedEnsured: string[];
  /** Owner password used to derive companion credentials (matches test PG bag). */
  ownerPassword: string;
};

export function createFakePreviewDb(
  options: { ownerPassword?: string } = {},
): FakePreviewDb {
  const created: string[] = [];
  const dropped: string[] = [];
  const restrictedEnsured: string[] = [];
  const ownerPassword = options.ownerPassword ?? "preview-secret";

  return {
    created,
    dropped,
    restrictedEnsured,
    ownerPassword,
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
