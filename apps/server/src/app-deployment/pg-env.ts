import {
  CANONICAL_ENV_KEYS,
  type CanonicalEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";

/** Gateway-owned Postgres connection fields for preview containers. */
export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/**
 * Connection vars for preview DB access (gateway-owned).
 * Five owner fields plus per-DB restricted companion (`PGAPPUSER` /
 * `PGAPPPASSWORD`). Optional remap replaces emitted names (no dual alias);
 * unmapped stay canonical.
 */
export function pgConnectionEnv(
  pg: AppDeployPg,
  dbName: string,
  connectionEnv?: PreviewEnvMap,
): string[] {
  const restrictedUser = restrictedRoleName(dbName);
  const restrictedPassword = deriveRestrictedPassword(pg.password, dbName);
  const fields: [CanonicalEnvKey, string][] = [
    ["PGHOST", pg.host],
    ["PGPORT", String(pg.port)],
    ["PGUSER", pg.user],
    ["PGPASSWORD", pg.password],
    ["PGDATABASE", dbName],
    ["PGAPPUSER", restrictedUser],
    ["PGAPPPASSWORD", restrictedPassword],
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
 * Gateway connection keys replace colliding user env keys (app or seed).
 * Reserved = canonical PG* ∪ emitted names (after remap), then append
 * gateway env once — remapping must not reopen override holes on PG*.
 */
export function withGatewayConnectionEnv(
  userEnv: string[],
  gatewayEnv: string[],
): string[] {
  const reserved = new Set<string>([
    ...CANONICAL_ENV_KEYS,
    ...gatewayEnv.map(envKey),
  ]);
  return [
    ...userEnv.filter((e) => !reserved.has(envKey(e))),
    ...gatewayEnv,
  ];
}
