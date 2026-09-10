import type { PreviewEnvMap } from "@sprout/preview-env";
import { traefikLabels } from "./labels.ts";
import {
  pgConnectionEnv,
  withGatewayConnectionEnv,
  type AppDeployPg,
} from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewContainerName } from "../preview/naming.ts";

export type { AppDeployPg };

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

/** Force-remove the preview app container for one PR (idempotent via Engine). */
export async function removePreviewApp(
  docker: PreviewDocker,
  slug: string,
  prId: number,
): Promise<void> {
  await docker.removeByName(previewContainerName(slug, prId));
}

/**
 * Replace (or first-start) the preview app container for one PR.
 * Force-removes any prior container with the stable name, then creates+starts
 * with dual-network attach, Traefik labels, adopter app env, and connection env
 * (PG* names, optionally remapped via connectionEnv). Gateway connection keys
 * replace colliding user app-env keys (PG* or remapped names), same policy as seed.
 * Resolves Traefik port from image EXPOSE (or previewPortDefault).
 * Caller must already have pulled the image (outside the preview lock).
 */
export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  const exposed = await deps.docker.firstExposedPort(input.image);
  const port = exposed ?? deps.previewPortDefault;
  const name = previewContainerName(input.slug, input.prId);
  await removePreviewApp(deps.docker, input.slug, input.prId);
  const { id } = await deps.docker.createAndStart({
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
    }),
    networkNames: [deps.networks.traefik, deps.networks.postgres],
  });
  return { containerId: id, port };
}
