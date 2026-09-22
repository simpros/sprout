import type { TraefikForwardAuth, TraefikTls } from "./labels.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewContainerName } from "../preview/naming.ts";
import type { PreviewDbPlan } from "../preview/runtime.ts";
import { materializePreviewWorkload } from "./preview-containers.ts";
import { appRouting } from "./workload-labels.ts";
import type { PreviewLabels } from "@sprout/preview-env";

export type ReplacePreviewAppDeps = {
  docker: PreviewDocker;
  previewPortDefault: number;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  appEnv: string[];
  plan: PreviewDbPlan;
  labels?: PreviewLabels;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
};

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
    routing: appRouting(input.hostname, input),
    gatewayEnv: input.plan.gatewayEnv,
    volumes: input.plan.volumes,
    networkNames: input.plan.appNetworks,
    previewPortDefault: deps.previewPortDefault,
    ...(input.labels !== undefined ? { previewLabels: input.labels } : {}),
  });
}
