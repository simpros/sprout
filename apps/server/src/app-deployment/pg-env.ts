/** Gateway-owned Postgres connection fields for preview containers. */
export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/** Five PG* vars for preview DB access (gateway-owned). */
export function pgConnectionEnv(pg: AppDeployPg, dbName: string): string[] {
  return [
    `PGHOST=${pg.host}`,
    `PGPORT=${String(pg.port)}`,
    `PGUSER=${pg.user}`,
    `PGPASSWORD=${pg.password}`,
    `PGDATABASE=${dbName}`,
  ];
}
