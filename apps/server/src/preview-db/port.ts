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
  /**
   * Create or sync the per-DB restricted companion LOGIN (`<dbName>_app`),
   * GRANT CONNECT + schema USAGE. Password is derived from the owner preview
   * password (stable across restarts). Call after the database exists.
   */
  ensureRestrictedRole(
    dbName: string,
  ): Promise<{ role: string; password: string }>;
  /** Connectivity check (`SELECT 1`). Throws when unreachable. */
  ping(): Promise<void>;
};
