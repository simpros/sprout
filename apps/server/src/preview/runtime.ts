import {
  normalizeDbSpec,
  resolveSqliteDatabaseUrl,
  type DbSpec,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import { pgConnectionEnv, type AppDeployPg } from "../app-deployment/pg-env.ts";
import { sqliteVolumeName } from "./naming.ts";

export type PreviewRuntime = {
  connectionEnv(
    db: DbSpec | undefined,
    dbName: string,
    remap?: PreviewEnvMap,
  ): string[];
  volumes(db: DbSpec | undefined, slug: string, prId: number): string[];
  appNetworks(db: DbSpec | undefined): string[];
  seedNetworks(db: DbSpec | undefined): string[];
};

export type PreviewRuntimeOptions = {
  pg: AppDeployPg;
  traefikNetwork: string;
  postgresNetwork: string;
};

export function resolveRuntime(deps: {
  pg: AppDeployPg;
  networks: { traefik: string; postgres: string };
  runtime?: PreviewRuntime;
}): PreviewRuntime {
  return (
    deps.runtime ??
    createPreviewRuntime({
      pg: deps.pg,
      traefikNetwork: deps.networks.traefik,
      postgresNetwork: deps.networks.postgres,
    })
  );
}

export function createPreviewRuntime(
  options: PreviewRuntimeOptions,
): PreviewRuntime {
  const { pg, traefikNetwork, postgresNetwork } = options;
  return {
    connectionEnv(db, dbName, remap) {
      const spec = normalizeDbSpec(db);
      if (spec.provider === "sqlite") {
        const target = remap?.DATABASE_URL ?? "DATABASE_URL";
        return [`${target}=${resolveSqliteDatabaseUrl(spec)}`];
      }
      return pgConnectionEnv(pg, dbName, remap);
    },
    volumes(db, slug, prId) {
      const spec = normalizeDbSpec(db);
      if (spec.provider === "sqlite") {
        return [`${sqliteVolumeName(slug, prId)}:${spec.path}`];
      }
      return [];
    },
    appNetworks(db) {
      if (normalizeDbSpec(db).provider === "sqlite") return [traefikNetwork];
      return [traefikNetwork, postgresNetwork];
    },
    seedNetworks(db) {
      if (normalizeDbSpec(db).provider === "sqlite") return [traefikNetwork];
      return [postgresNetwork];
    },
  };
}
