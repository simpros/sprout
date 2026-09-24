import {
  PREVIEW_ENV_KEYS,
  type CanonicalEnvKey,
  type DbRolesMode,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import { applyEnvRemap } from "./env-remap.ts";

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
  roles: DbRolesMode = "dual",
): string[] {
  const fields: [CanonicalEnvKey, string][] = [
    ["PGHOST", pg.host],
    ["PGPORT", String(pg.port)],
    ["PGUSER", pg.user],
    ["PGPASSWORD", pg.password],
    ["PGDATABASE", dbName],
  ];
  if (roles === "dual") {
    const restrictedUser = restrictedRoleName(dbName);
    const restrictedPassword = deriveRestrictedPassword(pg.password, dbName);
    fields.push(["PGAPPUSER", restrictedUser]);
    fields.push(["PGAPPPASSWORD", restrictedPassword]);
  }
  return applyEnvRemap(fields, connectionEnv);
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
    ...PREVIEW_ENV_KEYS,
    ...gatewayEnv.map(envKey),
  ]);
  return [
    ...userEnv.filter((e) => !reserved.has(envKey(e))),
    ...gatewayEnv,
  ];
}
