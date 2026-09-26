import type { CatalogContainer } from "../docker/port.ts";

export {
  dataVolumeName,
  parseDataVolumeName,
  parseSqliteVolumeName,
  sqliteVolumeName,
} from "@sprout/preview-env";

const PREVIEW_APP_CONTAINER_RE = /^sprout-([a-zA-Z0-9]+)-pr-(\d+)$/;
const PREVIEW_SERVICE_CONTAINER_RE =
  /^sprout-([a-zA-Z0-9]+)-pr-(\d+)-svc-([a-zA-Z0-9]+)$/;

export function previewContainerName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}`;
}

export function previewServiceContainerName(
  slug: string,
  prId: number,
  serviceName: string,
): string {
  return `sprout-${slug}-pr-${prId}-svc-${serviceName}`;
}

/** One-shot seed run name; the suffix stays outside the catalog regex. */
export function seedImageRunName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-seed`;
}

export function parsePreviewContainerName(
  name: string,
):
  | { slug: string; prId: number; kind: "app" }
  | { slug: string; prId: number; kind: "service"; serviceName: string }
  | null {
  const service = PREVIEW_SERVICE_CONTAINER_RE.exec(name);
  if (service) {
    return {
      slug: service[1]!,
      prId: Number(service[2]),
      kind: "service",
      serviceName: service[3]!,
    };
  }
  const app = PREVIEW_APP_CONTAINER_RE.exec(name);
  if (!app) return null;
  return { slug: app[1]!, prId: Number(app[2]), kind: "app" };
}

export function toCatalogContainer(
  containerId: string,
  containerName: string,
  parsed: NonNullable<ReturnType<typeof parsePreviewContainerName>>,
): CatalogContainer {
  return { ...parsed, containerId, containerName };
}
