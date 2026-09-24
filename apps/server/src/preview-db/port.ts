import type { DbRolesMode } from "@sprout/preview-env";

export type CatalogDatabase = {
  dbName: string;
  slug: string;
  prId: number;
};

export type CreateDatabaseOptions = {
  roles: DbRolesMode;
};

export type PreviewDb = {
  createDatabase(dbName: string, options: CreateDatabaseOptions): Promise<void>;
  dropDatabase(dbName: string): Promise<void>;
  listPreviewDatabases(): Promise<CatalogDatabase[]>;
  ensurePreviewRole(): Promise<void>;
  ping(): Promise<void>;
};
