import type { DbSpec, PreviewEnvMap } from "@sprout/preview-env";
import type { TraefikForwardAuth, TraefikTls } from "./labels.ts";
import type { AppDeployPg } from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewContainerName } from "../preview/naming.ts";
import { materializePreviewWorkload } from "./preview-containers.ts";
import { resolveRuntime, type PreviewRuntime } from "../preview/runtime.ts";

export type AppDeployNetworks = {
  traefik: string;
  postgres: string;
};

export type ReplacePreviewAppDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: AppDeployNetworks;
  previewPortDefault: number;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
  runtime?: PreviewRuntime;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  dbName: string;
  db?: DbSpec;
  appEnv: string[];
  connectionEnv?: PreviewEnvMap;
};

export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  const name = previewContainerName(input.slug, input.prId);
  await deps.docker.removeByName(name);
  const runtime = resolveRuntime(deps);
  return materializePreviewWorkload(deps.docker, {
    name,
    image: input.image,
    userEnv: input.appEnv,
    routing: {
      kind: "routed",
      hostname: input.hostname,
      tls: deps.traefikTls,
      forwardAuth: deps.traefikForwardAuth,
    },
    gatewayEnv: runtime.connectionEnv(input.db, input.dbName, input.connectionEnv),
    volumes: runtime.volumes(input.db, input.slug, input.prId),
    networkNames: runtime.appNetworks(input.db),
    previewPortDefault: deps.previewPortDefault,
  });
}
