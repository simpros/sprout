/** App container: sprout-<slug>-pr-<id> (no suffix). */
const PREVIEW_APP_CONTAINER_RE = /^sprout-([a-zA-Z0-9]+)-pr-(\d+)$/;
/** Service container: sprout-<slug>-pr-<id>-svc-<name>. */
const PREVIEW_SERVICE_CONTAINER_RE =
  /^sprout-([a-zA-Z0-9]+)-pr-(\d+)-svc-([a-zA-Z0-9]+)$/;

export function previewContainerName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}`;
}

/** Deterministic name for a long-lived preview service container. */
export function previewServiceContainerName(
  slug: string,
  prId: number,
  serviceName: string,
): string {
  return `sprout-${slug}-pr-${prId}-svc-${serviceName}`;
}

/** Deterministic name for the one-shot seed-image run (suffix avoids catalog regex). */
export function seedImageRunName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-seed`;
}

/**
 * Parse app or service container names into preview identity.
 * Seed (`-seed`) and other suffixes are not cataloged.
 */
export function parsePreviewContainerName(
  name: string,
): { slug: string; prId: number; serviceName?: string } | null {
  const service = PREVIEW_SERVICE_CONTAINER_RE.exec(name);
  if (service) {
    return {
      slug: service[1]!,
      prId: Number(service[2]),
      serviceName: service[3]!,
    };
  }
  const app = PREVIEW_APP_CONTAINER_RE.exec(name);
  if (!app) return null;
  return { slug: app[1]!, prId: Number(app[2]) };
}
