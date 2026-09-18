import type { TraefikForwardAuth, TraefikTls } from "./labels.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewContainerName } from "../preview/naming.ts";
import type { PreviewDbPlan } from "../preview/runtime.ts";
import { materializePreviewWorkload } from "./preview-containers.ts";

export type ReplacePreviewAppDeps = {
  docker: PreviewDocker;
  previewPortDefault: number;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  appEnv: string[];
  plan: PreviewDbPlan;
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
    routing: {
      kind: "routed",
      hostname: input.hostname,
      tls: deps.traefikTls,
      forwardAuth: deps.traefikForwardAuth,
    },
    gatewayEnv: input.plan.gatewayEnv,
    volumes: input.plan.volumes,
    networkNames: input.plan.appNetworks,
    previewPortDefault: deps.previewPortDefault,
  });
}
