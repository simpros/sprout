import {
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import { pgConnectionEnv, type AppDeployPg } from "../app-deployment/pg-env.ts";
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
 */
export type PreviewDbPlan = {
  provider: DbProvider;
  gatewayEnv: string[];
  volumes: string[];
  appNetworks: string[];
  seedNetworks: string[];
};

export function resolvePreviewPlan(
  ctx: PreviewMaterializationCtx,
  input: {
    spec: DbSpec;
    dbName: string | null;
    slug: string;
    prId: number;
    connectionEnv?: PreviewEnvMap;
  },
): PreviewDbPlan {
  if (input.spec.provider === "none") {
    return {
      provider: "none",
      gatewayEnv: [],
      volumes: [],
      appNetworks: [ctx.traefikNetwork],
      // Seed never runs for none; traefik is the network that always exists.
      seedNetworks: [ctx.traefikNetwork],
    };
  }
  if (input.spec.provider === "sqlite") {
    const target = input.connectionEnv?.DATABASE_URL ?? "DATABASE_URL";
    return {
      provider: "sqlite",
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
      `postgres plan requested for ${input.dbName} without postgres config`,
    );
  }
  if (input.dbName == null) {
    throw new Error("postgres plan requested without a database name");
  }
  return {
    provider: "postgres",
    gatewayEnv: pgConnectionEnv(postgres.pg, input.dbName, input.connectionEnv),
    volumes: [],
    appNetworks: [ctx.traefikNetwork, postgres.network],
    seedNetworks: [postgres.network],
  };
}
