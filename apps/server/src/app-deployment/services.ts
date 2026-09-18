import type { DbSpec, PreviewEnvMap } from "@sprout/preview-env";
import type { TraefikForwardAuth, TraefikTls } from "./labels.ts";
import type { AppDeployPg } from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewServiceContainerName } from "../preview/naming.ts";
import {
  materializePreviewWorkload,
  removePreviewServices,
} from "./preview-containers.ts";
import { resolveRuntime, type PreviewRuntime } from "../preview/runtime.ts";

export type PreviewServiceSpec = {
  name: string;
  image: string;
  hostname?: string;
  path?: string;
};

export type ReplacePreviewServicesDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: { traefik: string; postgres: string };
  previewPortDefault: number;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
  runtime?: PreviewRuntime;
};

export type ReplacePreviewServicesInput = {
  slug: string;
  prId: number;
  appHostname: string;
  dbName: string;
  db?: DbSpec;
  services: PreviewServiceSpec[];
  connectionEnv?: PreviewEnvMap;
};

export async function replacePreviewServices(
  deps: ReplacePreviewServicesDeps,
  input: ReplacePreviewServicesInput,
): Promise<void> {
  await removePreviewServices(deps.docker, input.slug, input.prId);

  const runtime = resolveRuntime(deps);
  try {
    await Promise.all(
      input.services.map(async (service) => {
        const name = previewServiceContainerName(
          input.slug,
          input.prId,
          service.name,
        );
        const routed = service.hostname != null || service.path != null;
        await materializePreviewWorkload(deps.docker, {
          name,
          image: service.image,
          userEnv: [],
          routing: routed
            ? {
                kind: "routed",
                hostname: service.hostname ?? input.appHostname,
                pathPrefix: service.path,
                tls: deps.traefikTls,
                forwardAuth: deps.traefikForwardAuth,
              }
            : { kind: "internal" },
          gatewayEnv: runtime.connectionEnv(
            input.db,
            input.dbName,
            input.connectionEnv,
          ),
          volumes: runtime.volumes(input.db, input.slug, input.prId),
          networkNames: runtime.appNetworks(input.db),
          previewPortDefault: deps.previewPortDefault,
        });
      }),
    );
  } catch (err) {
    try {
      await removePreviewServices(deps.docker, input.slug, input.prId);
    } catch {
      console.warn(
        `preview service cleanup failed for ${input.slug} pr=${input.prId} after create error`,
      );
    }
    throw err;
  }
}
