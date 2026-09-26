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
import { parseDataVolumeName } from "@sprout/preview-env";

export type { PreviewServiceSpec };

export type LiveContainerLogs = {
  app: string | null;
  seed: string | null;
};

export type DataVolumeRef = {
  name: string;
  slug: string;
  prId: number;
  index: number;
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
    networkNames: string[],
  ) => Promise<"ok" | "timeout">;
  runSeed: (input: SeedImageInput) => Promise<SeedImageResult>;
  remove: (slug: string, prId: number) => Promise<void>;
  list: () => Promise<CatalogContainer[]>;
  ensureDataVolumes: (names: string[]) => Promise<void>;
  removeDataVolumes: (slug: string, prId: number) => Promise<void>;
  removeDataVolume: (name: string) => Promise<void>;
  listDataVolumes: () => Promise<DataVolumeRef[]>;
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
    waitHealthy: (containerId, port, health, networkNames) =>
      pollHealth(
        probe,
        async () => {
          const ips = await Promise.all(
            networkNames.map((network) =>
              deps.docker.containerIpOnNetwork(containerId, network),
            ),
          );
          for (const ip of ips) {
            if (ip) return healthUrl(ip, port, health.path);
          }
          return null;
        },
        health,
        deps.healthClock,
      ),
    runSeed: (input) =>
      runSeedImage(
        {
          docker: deps.docker,
          seedTimeoutMs: deps.seedTimeoutMs,
        },
        input,
      ),
    remove: (slug, prId) => removePreviewFleet(deps.docker, slug, prId),
    list: () => deps.docker.listPreviewContainers(),
    ensureDataVolumes: async (names) => {
      for (const name of names) {
        await deps.docker.createVolume(name);
      }
    },
    removeDataVolumes: async (slug, prId) => {
      const volumes = await deps.docker.listVolumes();
      const owned = volumes.filter((name) => {
        const parsed = parseDataVolumeName(name);
        return parsed !== null && parsed.slug === slug && parsed.prId === prId;
      });
      await Promise.all(owned.map((name) => deps.docker.removeVolume(name)));
    },
    removeDataVolume: (name) => deps.docker.removeVolume(name),
    listDataVolumes: async () => {
      const out: DataVolumeRef[] = [];
      for (const name of await deps.docker.listVolumes()) {
        const parsed = parseDataVolumeName(name);
        if (!parsed) continue;
        out.push({ name, ...parsed });
      }
      return out;
    },
    liveLogs: (input) => fetchLiveContainerLogs(deps.docker, input),
  };
}
