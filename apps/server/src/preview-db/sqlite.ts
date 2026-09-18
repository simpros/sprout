import type { PreviewDocker } from "../docker/port.ts";
import {
  assertPreviewDbName,
  parsePreviewDatabaseName,
  previewDbName,
} from "./names.ts";
import {
  parseSqliteVolumeName,
  sqliteVolumeName,
} from "../preview/naming.ts";
import type { CatalogDatabase, PreviewDb } from "./port.ts";

export function createSqlitePreviewDb(docker: PreviewDocker): PreviewDb {
  function parseOrThrow(dbName: string): { slug: string; prId: number } {
    assertPreviewDbName(dbName);
    const parsed = parsePreviewDatabaseName(dbName);
    if (!parsed) throw new Error(`refusing unsafe preview database name: ${dbName}`);
    return parsed;
  }

  return {
    async createDatabase(dbName) {
      const parsed = parseOrThrow(dbName);
      await docker.createVolume(sqliteVolumeName(parsed.slug, parsed.prId));
    },

    async dropDatabase(dbName) {
      const parsed = parseOrThrow(dbName);
      await docker.removeVolume(sqliteVolumeName(parsed.slug, parsed.prId));
    },

    async listPreviewDatabases() {
      const out: CatalogDatabase[] = [];
      for (const name of await docker.listVolumes()) {
        const parsed = parseSqliteVolumeName(name);
        if (!parsed) continue;
        const dbName = previewDbName(parsed.slug, parsed.prId);
        if (!parsePreviewDatabaseName(dbName)) continue;
        out.push({ dbName, slug: parsed.slug, prId: parsed.prId });
      }
      return out;
    },

    async ensurePreviewRole() {},

    async ping() {
      await docker.listVolumes();
    },
  };
}
