import type { PreviewEnvMap } from "@sprout/preview-env";
import {
  traefikLabels,
  type TraefikForwardAuth,
  type TraefikTls,
} from "./labels.ts";
import {
  pgConnectionEnv,
  withGatewayConnectionEnv,
  type AppDeployPg,
} from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import {
  materializeContainer,
  previewContainerName,
  removePreviewFleet,
  resolveExposedPort,
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
 * Force-removes any prior container with the stable name, then creates+starts
 * with dual-network attach, Traefik labels, adopter app env, and connection env
 * (PG* names, optionally remapped via connectionEnv). Gateway connection keys
 * replace colliding user app-env keys (PG* or remapped names), same policy as seed.
 * Resolves Traefik port from image EXPOSE (or previewPortDefault).
 * Caller must already have pulled the image (outside the preview lock).
 * App-only remove: services sync after health in lifecycle.
 */
export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  const port = await resolveExposedPort(
    deps.docker,
    input.image,
    deps.previewPortDefault,
  );
  const name = previewContainerName(input.slug, input.prId);
  await deps.docker.removeByName(name);
  const { containerId } = await materializeContainer(deps.docker, {
    name,
    image: input.image,
    env: withGatewayConnectionEnv(
      input.appEnv,
      pgConnectionEnv(deps.pg, input.dbName, input.connectionEnv),
    ),
    labels: traefikLabels({
      routerName: name,
      hostname: input.hostname,
      port,
      tls: deps.traefikTls,
      forwardAuth: deps.traefikForwardAuth,
    }),
    networkNames: [deps.networks.traefik, deps.networks.postgres],
  });
  return { containerId, port };
}
