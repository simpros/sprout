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
  /**
   * Create or sync the static preview login (`LOGIN` + password) via the admin
   * connection. Throws a clear error when the admin lacks CREATEROLE.
   */
  ensurePreviewRole(): Promise<void>;
  /** Connectivity check (`SELECT 1`). Throws when unreachable. */
  ping(): Promise<void>;
};
