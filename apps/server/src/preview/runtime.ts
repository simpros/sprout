import {
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import { pgConnectionEnv, type AppDeployPg } from "../app-deployment/pg-env.ts";
import { sqliteVolumeName } from "./naming.ts";

/** Normalized specs only: callers normalize once via resolvePreviewPlan. */
export type PreviewRuntime = {
  connectionEnv(
    spec: DbSpec,
    dbName: string,
    remap?: PreviewEnvMap,
  ): string[];
  volumes(spec: DbSpec, slug: string, prId: number): string[];
  appNetworks(spec: DbSpec): string[];
  seedNetworks(spec: DbSpec): string[];
};

export type PreviewRuntimeOptions = {
  pg?: AppDeployPg;
  traefikNetwork: string;
  postgresNetwork: string;
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
  runtime: PreviewRuntime,
  input: {
    spec: DbSpec;
    dbName: string;
    slug: string;
    prId: number;
    connectionEnv?: PreviewEnvMap;
  },
): PreviewDbPlan {
  return {
    provider: input.spec.provider,
    gatewayEnv: runtime.connectionEnv(
      input.spec,
      input.dbName,
      input.connectionEnv,
    ),
    volumes: runtime.volumes(input.spec, input.slug, input.prId),
    appNetworks: runtime.appNetworks(input.spec),
    seedNetworks: runtime.seedNetworks(input.spec),
  };
}

export function createPreviewRuntime(
  options: PreviewRuntimeOptions,
): PreviewRuntime {
  const { pg, traefikNetwork, postgresNetwork } = options;
  return {
    connectionEnv(spec, dbName, remap) {
      if (spec.provider === "sqlite") {
        const target = remap?.DATABASE_URL ?? "DATABASE_URL";
        return [`${target}=${sqliteDatabaseUrl(spec.path, spec.file)}`];
      }
      if (!pg) {
        throw new Error(
          `postgres connection env requested for ${dbName} without postgres config`,
        );
      }
      return pgConnectionEnv(pg, dbName, remap);
    },
    volumes(spec, slug, prId) {
      if (spec.provider === "sqlite") {
        return [`${sqliteVolumeName(slug, prId)}:${spec.path}`];
      }
      return [];
    },
    appNetworks(spec) {
      if (spec.provider === "sqlite") return [traefikNetwork];
      return [traefikNetwork, postgresNetwork];
    },
    seedNetworks(spec) {
      // Seed needs no postgres data; traefik is the network that always exists.
      if (spec.provider === "sqlite") return [traefikNetwork];
      return [postgresNetwork];
    },
  };
}
