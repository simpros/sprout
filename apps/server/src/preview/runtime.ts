import {
  requiresDatabase,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import { pgConnectionEnv, type AppDeployPg } from "../app-deployment/pg-env.ts";
import { previewDbName } from "../preview-db/names.ts";
import { sqliteVolumeName } from "./naming.ts";

/**
 * Materialization inputs. Postgres is present only when the gateway
 * configures it, so a postgres plan on a sqlite-only gateway fails by type.
 */
export type PreviewMaterializationCtx = {
  traefikNetwork: string;
  postgres?: {
    pg: AppDeployPg;
    network: string;
  };
};

/**
 * Concrete materialization resolved once at the deploy boundary.
 * Lifecycle and app-deployment consume the plan; raw DbSpec never travels.
 * dbName is the owned backend resource name, null when there is none.
 */
export type PreviewDbPlan = {
  provider: DbProvider;
  dbName: string | null;
  gatewayEnv: string[];
  volumes: string[];
  appNetworks: string[];
  seedNetworks: string[];
};

export function resolvePreviewPlan(
  ctx: PreviewMaterializationCtx,
  input: {
    spec: DbSpec;
    slug: string;
    prId: number;
    connectionEnv?: PreviewEnvMap;
    /** Test override; deploy omits it so identity resolves in one place. */
    dbName?: string | null;
  },
): PreviewDbPlan {
  const dbName =
    input.dbName !== undefined
      ? input.dbName
      : requiresDatabase(input.spec.provider)
        ? previewDbName(input.slug, input.prId)
        : null;
  if (input.spec.provider === "none") {
    return {
      provider: "none",
      dbName,
      gatewayEnv: [],
      volumes: [],
      appNetworks: [ctx.traefikNetwork],
      // Seed is rejected for none, so no seed network ever runs.
      seedNetworks: [],
    };
  }
  if (input.spec.provider === "sqlite") {
    const target = input.connectionEnv?.DATABASE_URL ?? "DATABASE_URL";
    return {
      provider: "sqlite",
      dbName,
      gatewayEnv: [
        `${target}=${sqliteDatabaseUrl(input.spec.path, input.spec.file)}`,
      ],
      volumes: [`${sqliteVolumeName(input.slug, input.prId)}:${input.spec.path}`],
      appNetworks: [ctx.traefikNetwork],
      // Seed needs no postgres data; traefik is the network that always exists.
      seedNetworks: [ctx.traefikNetwork],
    };
  }
  const postgres = ctx.postgres;
  if (!postgres) {
    throw new Error(
      `postgres plan requested for ${dbName} without postgres config`,
    );
  }
  if (dbName == null) {
    throw new Error("postgres plan requested without a database name");
  }
  return {
    provider: "postgres",
    dbName,
    gatewayEnv: pgConnectionEnv(postgres.pg, dbName, input.connectionEnv),
    volumes: [],
    appNetworks: [ctx.traefikNetwork, postgres.network],
    seedNetworks: [postgres.network],
  };
}
