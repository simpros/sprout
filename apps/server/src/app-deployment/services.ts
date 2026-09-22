import type { PreviewLabels, PreviewServiceSpec } from "@sprout/preview-env";
import type { TraefikForwardAuth, TraefikTls } from "./labels.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewServiceContainerName } from "../preview/naming.ts";
import type { PreviewDbPlan } from "../preview/runtime.ts";
import {
  materializePreviewWorkload,
  removePreviewServices,
} from "./preview-containers.ts";
import { serviceRouting } from "./workload-labels.ts";

export type { PreviewServiceSpec };

export type ReplacePreviewServicesDeps = {
  docker: PreviewDocker;
  previewPortDefault: number;
};

export type ReplacePreviewServicesInput = {
  slug: string;
  prId: number;
  appHostname: string;
  services: PreviewServiceSpec[];
  plan: PreviewDbPlan;
  previewLabels?: PreviewLabels;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
};

function toEnvList(env: Record<string, string> | undefined): string[] {
  return env ? Object.entries(env).map(([key, value]) => `${key}=${value}`) : [];
}

export async function replacePreviewServices(
  deps: ReplacePreviewServicesDeps,
  input: ReplacePreviewServicesInput,
): Promise<void> {
  await removePreviewServices(deps.docker, input.slug, input.prId);

  try {
    await Promise.all(
      input.services.map(async (service, index) => {
        const name = previewServiceContainerName(
          input.slug,
          input.prId,
          service.name,
        );
        const userEnv = toEnvList(service.env);
        await materializePreviewWorkload(deps.docker, {
          name,
          image: service.image,
          userEnv,
          routing: serviceRouting(service, input.appHostname, input),
          gatewayEnv: input.plan.gatewayEnv,
          volumes: input.plan.volumes,
          networkNames: input.plan.appNetworks,
          previewPortDefault: deps.previewPortDefault,
          portOverride: service.port,
          ...(input.previewLabels !== undefined
            ? { previewLabels: input.previewLabels }
            : {}),
          service: { labels: service.labels, index },
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
