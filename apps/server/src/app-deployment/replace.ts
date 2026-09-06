import { traefikLabels } from "./labels.ts";
import type { CatalogContainer, PreviewDocker } from "../docker/port.ts";
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
  remove: (slug: string, prId: number) => Promise<void>;
  /** IPv4 on a Docker network (health poll target), or null if unset. */
  containerIpOnNetwork: (
    containerId: string,
    networkName: string,
  ) => Promise<string | null>;
  /** Catalog of running pb-* containers (orphan sweep). */
  list: () => Promise<CatalogContainer[]>;
};

export function bindPreviewApp(deps: ReplacePreviewAppDeps): PreviewAppOps {
  return {
    pullImage: (image) => deps.docker.pullImage(image),
    replace: (input) => replacePreviewApp(deps, input),
    remove: (slug, prId) => removePreviewApp(deps.docker, slug, prId),
    containerIpOnNetwork: (containerId, networkName) =>
      deps.docker.containerIpOnNetwork(containerId, networkName),
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
