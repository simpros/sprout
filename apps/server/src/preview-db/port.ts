/** One catalog entry from the shared Postgres instance. */
export type CatalogDatabase = {
  dbName: string;
  slug: string;
  prId: number;
};

/** Admin operations on the shared Postgres instance for preview databases. */
export type PreviewDb = {
  createDatabase(dbName: string): Promise<void>;
  dropDatabase(dbName: string): Promise<void>;
  listPreviewDatabases(): Promise<CatalogDatabase[]>;
  /** Connectivity check (`SELECT 1`). Throws when unreachable. */
  ping(): Promise<void>;
};
