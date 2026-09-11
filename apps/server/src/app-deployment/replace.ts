import type { PreviewEnvMap } from "@sprout/preview-env";
import type { TraefikForwardAuth, TraefikTls } from "./labels.ts";
import type { AppDeployPg } from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import {
  materializePreviewWorkload,
  previewContainerName,
  removePreviewFleet,
} from "./preview-containers.ts";

export type { AppDeployPg };
export type { TraefikForwardAuth, TraefikTls };
export { removePreviewFleet };

export type AppDeployNetworks = {
  traefik: string;
  postgres: string;
};

/** Replace/health deps only — seed timeout binds at composition (ops.ts). */
export type ReplacePreviewAppDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: AppDeployNetworks;
  previewPortDefault: number;
  /** Router TLS policy; absent = HTTP-only labels (no tls/entrypoints). */
  traefikTls?: TraefikTls;
  /** ForwardAuth policy; absent = no middleware labels. */
  traefikForwardAuth?: TraefikForwardAuth;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  dbName: string;
  /** Adopter KEY=VALUE entries; colliding connection keys are stripped. */
  appEnv: string[];
  /** Request-scoped connection env name remap; not persisted. */
  connectionEnv?: PreviewEnvMap;
};

/**
 * Replace (or first-start) the preview app container for one PR.
 * Force-removes any prior container with the stable name, then materializes
 * with Traefik routing. Caller must already have pulled the image.
 * App-only remove: companion sync runs after promote/seed in bring-up.
 */
export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  const name = previewContainerName(input.slug, input.prId);
  await deps.docker.removeByName(name);
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
    networks: deps.networks,
    pg: deps.pg,
    dbName: input.dbName,
    connectionEnv: input.connectionEnv,
    previewPortDefault: deps.previewPortDefault,
  });
}
