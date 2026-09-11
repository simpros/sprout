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
  previewContainerName,
  previewServiceContainerName,
} from "../preview/naming.ts";

export type PreviewWorkloadRouting =
  | {
      kind: "routed";
      hostname: string;
      pathPrefix?: string;
      tls?: TraefikTls;
      /** Public Host/PathPrefix routes inherit gateway SSO when set. */
      forwardAuth?: TraefikForwardAuth;
    }
  | { kind: "internal" };

export type MaterializePreviewWorkloadInput = {
  name: string;
  image: string;
  /** Adopter KEY=VALUE; colliding connection keys are stripped. */
  userEnv: string[];
  routing: PreviewWorkloadRouting;
  networks: { traefik: string; postgres: string };
  pg: AppDeployPg;
  dbName: string;
  connectionEnv?: PreviewEnvMap;
  previewPortDefault: number;
};

/**
 * Create+start one preview workload (app or service): resolve EXPOSE, build
 * connection env + optional Traefik labels, dual-network attach.
 * Caller owns naming and any prior remove.
 */
export async function materializePreviewWorkload(
  docker: PreviewDocker,
  input: MaterializePreviewWorkloadInput,
): Promise<{ containerId: string; port: number }> {
  const port =
    (await docker.firstExposedPort(input.image)) ?? input.previewPortDefault;
  const labels =
    input.routing.kind === "routed"
      ? traefikLabels({
          routerName: input.name,
          hostname: input.routing.hostname,
          port,
          pathPrefix: input.routing.pathPrefix,
          tls: input.routing.tls,
          forwardAuth: input.routing.forwardAuth,
        })
      : {};
  const { id } = await docker.createAndStart({
    name: input.name,
    image: input.image,
    env: withGatewayConnectionEnv(
      input.userEnv,
      pgConnectionEnv(input.pg, input.dbName, input.connectionEnv),
    ),
    labels,
    networkNames: [input.networks.traefik, input.networks.postgres],
  });
  return { containerId: id, port };
}

/** Force-remove every cataloged container for one preview (app + services). */
export async function removePreviewFleet(
  docker: PreviewDocker,
  slug: string,
  prId: number,
): Promise<void> {
  const names = new Set<string>([previewContainerName(slug, prId)]);
  for (const c of await docker.listPreviewContainers()) {
    if (c.slug === slug && c.prId === prId) {
      names.add(c.containerName);
    }
  }
  await Promise.all([...names].map((name) => docker.removeByName(name)));
}

/** Remove only service containers for one preview (leave the app). */
export async function removePreviewServices(
  docker: PreviewDocker,
  slug: string,
  prId: number,
): Promise<void> {
  const catalog = await docker.listPreviewContainers();
  await Promise.all(
    catalog
      .filter(
        (c) => c.slug === slug && c.prId === prId && c.kind === "service",
      )
      .map((c) => docker.removeByName(c.containerName)),
  );
}

export { previewContainerName, previewServiceContainerName };
