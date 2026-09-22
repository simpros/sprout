import {
  mergePreviewLabels,
  type ServiceLabelSource,
} from "./labels.ts";
import {
  gatewayLabels as gatewayLabelsForWorkload,
  type PreviewWorkloadRouting,
} from "./workload-labels.ts";
import { withGatewayConnectionEnv } from "./pg-env.ts";
import type { PreviewDocker } from "../docker/port.ts";
import { previewContainerName } from "../preview/naming.ts";
import type { PreviewLabels } from "@sprout/preview-env";

export type { PreviewWorkloadRouting } from "./workload-labels.ts";

export type MaterializePreviewWorkloadInput = {
  name: string;
  image: string;
  userEnv: string[];
  routing: PreviewWorkloadRouting;
  gatewayEnv: string[];
  volumes: string[];
  networkNames: string[];
  previewPortDefault: number;
  portOverride?: number;
  previewLabels?: PreviewLabels;
  service?: ServiceLabelSource;
};

export async function materializePreviewWorkload(
  docker: PreviewDocker,
  input: MaterializePreviewWorkloadInput,
): Promise<{ containerId: string; port: number }> {
  const port =
    input.portOverride ??
    ((await docker.firstExposedPort(input.image)) ?? input.previewPortDefault);
  const gatewayLabels =
    gatewayLabelsForWorkload(input.name, input.routing, port);
  const labels = mergePreviewLabels(
    gatewayLabels,
    input.previewLabels,
    input.service,
  );
  const { id } = await docker.createAndStart({
    name: input.name,
    image: input.image,
    env: withGatewayConnectionEnv(input.userEnv, input.gatewayEnv),
    labels,
    networkNames: input.networkNames,
    ...(input.volumes.length > 0 ? { volumes: input.volumes } : {}),
  });
  return { containerId: id, port };
}

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
