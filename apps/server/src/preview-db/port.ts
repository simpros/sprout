import type { DbSpec } from "@sprout/preview-env";

export type CatalogDatabase = {
  dbName: string;
  slug: string;
  prId: number;
};

export type PreviewDb = {
  createDatabase(dbName: string, db?: DbSpec): Promise<void>;
  dropDatabase(dbName: string): Promise<void>;
  listPreviewDatabases(): Promise<CatalogDatabase[]>;
  ensurePreviewRole(): Promise<void>;
  ping(): Promise<void>;
};
