const PREVIEW_CONTAINER_RE = /^pb-([a-zA-Z0-9]+)-pr-(\d+)$/;

/** Re-export DB parse from the single preview-db grammar. */
export { parsePreviewDatabaseName } from "../preview-db/names.ts";

export function previewContainerName(slug: string, prId: number): string {
  return `pb-${slug}-pr-${prId}`;
}

/** One-shot seed container; suffix keeps it out of preview-name catalog regex. */
export function seedContainerName(slug: string, prId: number): string {
  return `pb-${slug}-pr-${prId}-seed`;
}

export function parsePreviewContainerName(
  name: string,
): { slug: string; prId: number } | null {
  const match = PREVIEW_CONTAINER_RE.exec(name);
  if (!match) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}
