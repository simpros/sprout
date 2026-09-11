import type { PreviewDocker } from "../docker/port.ts";
import {
  previewContainerName,
  previewServiceContainerName,
} from "../preview/naming.ts";

export type MaterializeContainerInput = {
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  networkNames: string[];
};

/** Resolve image EXPOSE or fall back to the gateway default preview port. */
export async function resolveExposedPort(
  docker: PreviewDocker,
  image: string,
  fallback: number,
): Promise<number> {
  return (await docker.firstExposedPort(image)) ?? fallback;
}

/**
 * Create+start one preview workload container (app or service).
 * Caller owns naming, env, labels, networks, and any prior remove.
 */
export async function materializeContainer(
  docker: PreviewDocker,
  input: MaterializeContainerInput,
): Promise<{ containerId: string }> {
  const { id } = await docker.createAndStart(input);
  return { containerId: id };
}

/** Force-remove every cataloged container for one preview (app + services). */
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

/** Remove only service containers for one preview (leave the app). */
export async function removePreviewServices(
  docker: PreviewDocker,
  slug: string,
  prId: number,
): Promise<void> {
  const catalog = await docker.listPreviewContainers();
  await Promise.all(
    catalog
      .filter(
        (c) =>
          c.slug === slug && c.prId === prId && c.serviceName != null,
      )
      .map((c) => docker.removeByName(c.containerName)),
  );
}

export { previewContainerName, previewServiceContainerName };
