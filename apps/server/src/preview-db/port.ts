export type CatalogDatabase = {
  dbName: string;
  slug: string;
  prId: number;
};

export type PreviewDb = {
  createDatabase(dbName: string): Promise<void>;
  dropDatabase(dbName: string): Promise<void>;
  listPreviewDatabases(): Promise<CatalogDatabase[]>;
  ensurePreviewRole(): Promise<void>;
  ping(): Promise<void>;
};
