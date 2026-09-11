import {
  defaultHealthProbe,
  pollHealth,
  healthUrl,
  type HealthClock,
  type HealthProbe,
  type HealthSpec,
} from "./health.ts";
import {
  removePreviewApp,
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

/** Live container log text; null = container missing (Docker 404). */
export type LiveContainerLogs = {
  app: string | null;
  seed: string | null;
};

/** Bound deploy ops for lifecycle/sweep — no PGHOST / network config at callers. */
export type PreviewAppOps = {
  pullImage: (image: string) => Promise<void>;
  replace: (
    input: ReplacePreviewAppInput,
  ) => Promise<{ containerId: string; port: number }>;
  /**
   * Replace long-lived service containers after the app is healthy.
   * Caller must already have pulled images. Empty list clears prior services.
   */
  replaceServices: (input: ReplacePreviewServicesInput) => Promise<void>;
  /** Poll postgres-network IP until HealthSpec expects success or timeout. */
  waitHealthy: (
    containerId: string,
    port: number,
    health: HealthSpec,
  ) => Promise<"ok" | "timeout">;
  /** One-shot seed image on Postgres network; caller already pulled the image. */
  runSeed: (input: SeedImageInput) => Promise<SeedImageResult>;
  /** Remove app + all service containers for one PR. */
  remove: (slug: string, prId: number) => Promise<void>;
  /** Catalog of running sprout-* containers (orphan sweep). */
  list: () => Promise<CatalogContainer[]>;
  /**
   * Live app + seed container text in parallel.
   * Missing container → null (caller merges with stored seed_log).
   */
  liveLogs: (input: {
    slug: string;
    prId: number;
    tail: number;
  }) => Promise<LiveContainerLogs>;
};

export type BindPreviewOpsDeps = ReplacePreviewAppDeps & {
  /** Wall-clock bound for one-shot seed image runs (SPROUT_SEED_TIMEOUT). */
  seedTimeoutMs: number;
  /** Test seam — defaults to fetch-based probe. */
  healthProbe?: HealthProbe;
  /** Test seam — defaults to Date.now / setTimeout. */
  healthClock?: HealthClock;
};

/** Parallel Docker log pulls for app + seed container names. */
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

/** Compose replace/health + seed at the composition root (not in replace.ts). */
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
    remove: (slug, prId) => removePreviewApp(deps.docker, slug, prId),
    list: () => deps.docker.listPreviewContainers(),
    liveLogs: (input) => fetchLiveContainerLogs(deps.docker, input),
  };
}
