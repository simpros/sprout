import type { HealthSpec } from "@sprout/preview-env";
import {
  defaultHealthProbe,
  pollHealth,
  healthUrl,
  type HealthClock,
  type HealthProbe,
} from "./health.ts";
import { removePreviewFleet } from "./preview-containers.ts";
import {
  replacePreviewApp,
  type ReplacePreviewAppDeps,
  type ReplacePreviewAppInput,
} from "./replace.ts";
import {
  replacePreviewServices,
  type PreviewServiceSpec,
  type ReplacePreviewServicesInput,
} from "./services.ts";
import {
  runSeedImage,
  type SeedImageInput,
  type SeedImageResult,
} from "./seed.ts";
import type { CatalogContainer, PreviewDocker } from "../docker/port.ts";
import {
  previewContainerName,
  seedImageRunName,
} from "../preview/naming.ts";

export type { PreviewServiceSpec };

export type LiveContainerLogs = {
  app: string | null;
  seed: string | null;
};

export type PreviewAppOps = {
  pullImage: (image: string) => Promise<void>;
  replace: (
    input: ReplacePreviewAppInput,
  ) => Promise<{ containerId: string; port: number }>;
  replaceServices: (input: ReplacePreviewServicesInput) => Promise<void>;
  waitHealthy: (
    containerId: string,
    port: number,
    health: HealthSpec,
  ) => Promise<"ok" | "timeout">;
  runSeed: (input: SeedImageInput) => Promise<SeedImageResult>;
  remove: (slug: string, prId: number) => Promise<void>;
  list: () => Promise<CatalogContainer[]>;
  liveLogs: (input: {
    slug: string;
    prId: number;
    tail: number;
  }) => Promise<LiveContainerLogs>;
};

export type BindPreviewOpsDeps = ReplacePreviewAppDeps & {
  seedTimeoutMs: number;
  healthProbe?: HealthProbe;
  healthClock?: HealthClock;
};

export async function fetchLiveContainerLogs(
  docker: PreviewDocker,
  input: { slug: string; prId: number; tail: number },
): Promise<LiveContainerLogs> {
  const [app, seed] = await Promise.all([
    docker.containerLogs(
      previewContainerName(input.slug, input.prId),
      { tail: input.tail },
    ),
    docker.containerLogs(
      seedImageRunName(input.slug, input.prId),
      { tail: input.tail },
    ),
  ]);
  return { app, seed };
}

export function bindPreviewOps(deps: BindPreviewOpsDeps): PreviewAppOps {
  const probe = deps.healthProbe ?? defaultHealthProbe();
  return {
    pullImage: (image) => deps.docker.pullImage(image),
    replace: (input) => replacePreviewApp(deps, input),
    replaceServices: (input) => replacePreviewServices(deps, input),
    waitHealthy: (containerId, port, health) =>
      pollHealth(
        probe,
        async () => {
          const ip = await deps.docker.containerIpOnNetwork(
            containerId,
            deps.networks.postgres,
          );
          return ip ? healthUrl(ip, port, health.path) : null;
        },
        health,
        deps.healthClock,
      ),
    runSeed: (input) =>
      runSeedImage(
        {
          docker: deps.docker,
          pg: deps.pg,
          networks: { postgres: deps.networks.postgres },
          seedTimeoutMs: deps.seedTimeoutMs,
        },
        input,
      ),
    remove: (slug, prId) => removePreviewFleet(deps.docker, slug, prId),
    list: () => deps.docker.listPreviewContainers(),
    liveLogs: (input) => fetchLiveContainerLogs(deps.docker, input),
  };
}
