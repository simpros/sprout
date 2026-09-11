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
  previewServiceContainerName,
  removePreviewServices,
  resolveExposedPort,
} from "./preview-containers.ts";

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

export { removePreviewServices };

/**
 * Replace long-lived preview service containers for one PR.
 * Clears prior services for the preview, then creates each requested service
 * with dual-network attach and the same connection env as the app.
 * Traefik labels only when hostname and/or path is set (otherwise internal).
 * Caller must already have pulled images. Empty list clears without creating.
 */
export async function replacePreviewServices(
  deps: ReplacePreviewServicesDeps,
  input: ReplacePreviewServicesInput,
): Promise<void> {
  await removePreviewServices(deps.docker, input.slug, input.prId);

  const connection = pgConnectionEnv(
    deps.pg,
    input.dbName,
    input.connectionEnv,
  );

  await Promise.all(
    input.services.map(async (service) => {
      const port = await resolveExposedPort(
        deps.docker,
        service.image,
        deps.previewPortDefault,
      );
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

      await materializeContainer(deps.docker, {
        name,
        image: service.image,
        env: withGatewayConnectionEnv([], connection),
        labels,
        networkNames: [deps.networks.traefik, deps.networks.postgres],
      });
    }),
  );
}
