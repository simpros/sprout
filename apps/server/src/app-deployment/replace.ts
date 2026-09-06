import { traefikLabels } from "./labels.ts";
import {
  defaultHealthProbe,
  healthUrl,
  pollHealth,
  type HealthClock,
  type HealthProbe,
  type HealthSpec,
} from "./health.ts";
import {
  runSeedImage,
  type SeedImageInput,
  type SeedImageResult,
} from "./seed.ts";
import type { CatalogContainer, PreviewDocker } from "../docker/port.ts";
import { OPTIONAL_ENV_DEFAULTS } from "../config.ts";
import { previewContainerName } from "../preview/naming.ts";

export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export type AppDeployNetworks = {
  traefik: string;
  postgres: string;
};

export type ReplacePreviewAppDeps = {
  docker: PreviewDocker;
  pg: AppDeployPg;
  networks: AppDeployNetworks;
  previewPortDefault: number;
  /** Wall-clock bound for one-shot seed image runs (PB_SEED_TIMEOUT). */
  seedTimeoutMs?: number;
  /** Test seam — defaults to fetch-based probe. */
  healthProbe?: HealthProbe;
  /** Test seam — defaults to Date.now / setTimeout. */
  healthClock?: HealthClock;
};

export type ReplacePreviewAppInput = {
  slug: string;
  prId: number;
  hostname: string;
  image: string;
  dbName: string;
};

/** Bound deploy ops for lifecycle/sweep — no PGHOST / network config at callers. */
export type PreviewAppOps = {
  pullImage: (image: string) => Promise<void>;
  replace: (
    input: ReplacePreviewAppInput,
  ) => Promise<{ containerId: string; port: number }>;
  /** Poll postgres-network IP until HealthSpec expects success or timeout. */
  waitHealthy: (
    containerId: string,
    port: number,
    health: HealthSpec,
  ) => Promise<"ok" | "timeout">;
  /** One-shot seed image on Postgres network; caller already pulled the image. */
  runSeed: (input: SeedImageInput) => Promise<SeedImageResult>;
  remove: (slug: string, prId: number) => Promise<void>;
  /** Catalog of running pb-* containers (orphan sweep). */
  list: () => Promise<CatalogContainer[]>;
};

export function bindPreviewApp(deps: ReplacePreviewAppDeps): PreviewAppOps {
  const probe = deps.healthProbe ?? defaultHealthProbe();
  const seedTimeoutMs =
    deps.seedTimeoutMs ?? OPTIONAL_ENV_DEFAULTS.PB_SEED_TIMEOUT * 1000;
  return {
    pullImage: (image) => deps.docker.pullImage(image),
    replace: (input) => replacePreviewApp(deps, input),
    waitHealthy: (containerId, port, health) =>
      waitPreviewAppHealthy(deps, probe, containerId, port, health),
    runSeed: (input) =>
      runSeedImage(
        {
          docker: deps.docker,
          pg: deps.pg,
          networks: deps.networks,
          seedTimeoutMs,
        },
        input,
      ),
    remove: (slug, prId) => removePreviewApp(deps.docker, slug, prId),
    list: () => deps.docker.listPreviewContainers(),
  };
}

/** Force-remove the preview app container for one PR (idempotent via Engine). */
export async function removePreviewApp(
  docker: PreviewDocker,
  slug: string,
  prId: number,
): Promise<void> {
  await docker.removeByName(previewContainerName(slug, prId));
}

/**
 * Replace (or first-start) the preview app container for one PR.
 * Force-removes any prior container with the stable name, then creates+starts
 * with dual-network attach, Traefik labels, and PG* env only.
 * Resolves Traefik port from image EXPOSE (or previewPortDefault).
 * Caller must already have pulled the image (outside the preview lock).
 */
export async function replacePreviewApp(
  deps: ReplacePreviewAppDeps,
  input: ReplacePreviewAppInput,
): Promise<{ containerId: string; port: number }> {
  const exposed = await deps.docker.firstExposedPort(input.image);
  const port = exposed ?? deps.previewPortDefault;
  const name = previewContainerName(input.slug, input.prId);
  await removePreviewApp(deps.docker, input.slug, input.prId);
  const { id } = await deps.docker.createAndStart({
    name,
    image: input.image,
    env: [
      `PGHOST=${deps.pg.host}`,
      `PGPORT=${String(deps.pg.port)}`,
      `PGUSER=${deps.pg.user}`,
      `PGPASSWORD=${deps.pg.password}`,
      `PGDATABASE=${input.dbName}`,
    ],
    labels: traefikLabels({
      routerName: name,
      hostname: input.hostname,
      port,
    }),
    networkNames: [deps.networks.traefik, deps.networks.postgres],
  });
  return { containerId: id, port };
}

async function waitPreviewAppHealthy(
  deps: ReplacePreviewAppDeps,
  probe: HealthProbe,
  containerId: string,
  port: number,
  health: HealthSpec,
): Promise<"ok" | "timeout"> {
  // Total: never throws — inspect/resolve blips retry until HealthSpec timeout.
  return pollHealth(
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
  );
}
