import {
  type CanonicalEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";

/** Gateway-owned Postgres connection fields for preview containers. */
export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/**
 * Five connection vars for preview DB access (gateway-owned).
 * Optional remap replaces emitted names (no dual alias); unmapped stay PG*.
 */
export function pgConnectionEnv(
  pg: AppDeployPg,
  dbName: string,
  connectionEnv?: PreviewEnvMap,
): string[] {
  const fields: [CanonicalEnvKey, string][] = [
    ["PGHOST", pg.host],
    ["PGPORT", String(pg.port)],
    ["PGUSER", pg.user],
    ["PGPASSWORD", pg.password],
    ["PGDATABASE", dbName],
  ];
  return fields.map(
    ([key, value]) => `${connectionEnv?.[key] ?? key}=${value}`,
  );
}

function envKey(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? entry : entry.slice(0, eq);
}

/**
 * Gateway connection keys replace colliding user seed-env keys.
 * Strip by emitted names (after remap), then append gateway env once —
 * never rely on duplicate Env last-wins.
 */
export function withGatewayConnectionEnv(
  userEnv: string[],
  gatewayEnv: string[],
): string[] {
  const gatewayKeys = new Set(gatewayEnv.map(envKey));
  return [
    ...userEnv.filter((e) => !gatewayKeys.has(envKey(e))),
    ...gatewayEnv,
  ];
}
