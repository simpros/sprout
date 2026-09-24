import type { DbProvider } from "@sprout/preview-env";
import { parsePreviewDatabaseName } from "./names.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";
import type { PreviewDbRouter } from "./routing.ts";

export type FakePreviewDb = PreviewDb &
  PreviewDbRouter & {
    created: string[];
    dropped: string[];
    restrictedEnsured: string[];
  };

export function createFakePreviewDb(): FakePreviewDb & PreviewDbRouter {
  const created: string[] = [];
  const dropped: string[] = [];
  const restrictedEnsured: string[] = [];

  const fake: FakePreviewDb & PreviewDbRouter = {
    created,
    dropped,
    restrictedEnsured,
    async createDatabase(dbName, options) {
      const live = new Set(created);
      for (const name of dropped) live.delete(name);
      if (!live.has(dbName)) {
        created.push(dbName);
      }
      if (options.roles === "dual") {
        restrictedEnsured.push(dbName);
      }
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
    forCreate(_provider: DbProvider) {
      return fake;
    },
    forDrop(_provider: DbProvider | undefined) {
      return fake;
    },
  };
  return fake;
}
