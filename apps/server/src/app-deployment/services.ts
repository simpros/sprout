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

export type PreviewServiceSpec = {
  /** Alphanumeric service id (same grammar as slug). */
  name: string;
  image: string;
  /** Optional Host(); when omitted with path, falls back to app hostname. */
  hostname?: string;
  /** Optional PathPrefix (e.g. `/api`). */
  path?: string;
};

export type ReplacePreviewServicesDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: { traefik: string; postgres: string };
  previewPortDefault: number;
  traefikTls?: TraefikTls;
  /** Inherited by routed services (Host/PathPrefix public routes). */
  traefikForwardAuth?: TraefikForwardAuth;
};

export type ReplacePreviewServicesInput = {
  slug: string;
  prId: number;
  /** App hostname — used when a service has path but no hostname. */
  appHostname: string;
  dbName: string;
  services: PreviewServiceSpec[];
  connectionEnv?: PreviewEnvMap;
};

/** Force-remove every cataloged container for one preview (app + services). */
export async function removePreviewContainers(
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
        (c) =>
          c.slug === slug &&
          c.prId === prId &&
          c.containerName !== previewContainerName(slug, prId),
      )
      .map((c) => docker.removeByName(c.containerName)),
  );
}

/**
 * Replace long-lived preview service containers for one PR.
 * Clears prior services for the preview, then creates each requested service
 * with dual-network attach and the same connection env as the app.
 * Traefik labels only when hostname and/or path is set (otherwise internal).
 * Caller must already have pulled images.
 */
export async function replacePreviewServices(
  deps: ReplacePreviewServicesDeps,
  input: ReplacePreviewServicesInput,
): Promise<void> {
  await removePreviewServices(deps.docker, input.slug, input.prId);

  for (const service of input.services) {
    const exposed = await deps.docker.firstExposedPort(service.image);
    const port = exposed ?? deps.previewPortDefault;
    const name = previewServiceContainerName(
      input.slug,
      input.prId,
      service.name,
    );
    const routeHost = service.hostname ?? input.appHostname;
    const routed = service.hostname != null || service.path != null;
    const labels = routed
      ? traefikLabels({
          routerName: name,
          hostname: routeHost,
          port,
          pathPrefix: service.path,
          tls: deps.traefikTls,
          forwardAuth: deps.traefikForwardAuth,
        })
      : {};

    await deps.docker.createAndStart({
      name,
      image: service.image,
      env: withGatewayConnectionEnv(
        [],
        pgConnectionEnv(deps.pg, input.dbName, input.connectionEnv),
      ),
      labels,
      networkNames: [deps.networks.traefik, deps.networks.postgres],
    });
  }
}
