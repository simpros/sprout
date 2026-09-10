const PREVIEW_CONTAINER_RE = /^sprout-([a-zA-Z0-9]+)-pr-(\d+)$/;

export function previewContainerName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}`;
}

/** Deterministic name for the one-shot seed-image run (suffix avoids catalog regex). */
export function seedImageRunName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-seed`;
}

export function parsePreviewContainerName(
  name: string,
): { slug: string; prId: number } | null {
  const match = PREVIEW_CONTAINER_RE.exec(name);
  if (!match) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}
