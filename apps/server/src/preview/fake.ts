import type { CatalogContainer, ContainerPorts } from "./containers.ts";

export type FakeContainers = ContainerPorts & {
  seeded: CatalogContainer[];
  removed: { slug: string; prId: number }[];
  seed: (container: CatalogContainer) => void;
};

export function createFakeContainers(
  initial: CatalogContainer[] = [],
): FakeContainers {
  const seeded = [...initial];
  const removed: { slug: string; prId: number }[] = [];
  return {
    seeded,
    removed,
    seed(container) {
      seeded.push(container);
    },
    async listPreviewContainers() {
      return seeded.filter(
        (c) =>
          !removed.some((r) => r.slug === c.slug && r.prId === c.prId),
      );
    },
    async remove({ slug, prId }) {
      removed.push({ slug, prId });
    },
  };
}
