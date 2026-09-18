import {
  CANONICAL_ENV_KEYS,
  type CanonicalEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";

export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

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
