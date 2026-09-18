/** -sqlite suffix stays outside the container and Postgres catalogs. */
export function sqliteVolumeName(slug: string, prId: number): string {
  return `sprout-${slug}-pr-${prId}-sqlite`;
}

const SQLITE_VOLUME_RE = /^sprout-([a-zA-Z0-9]+)-pr-(\d+)-sqlite$/;

export function parseSqliteVolumeName(
  name: string,
): { slug: string; prId: number } | null {
  const match = SQLITE_VOLUME_RE.exec(name);
  if (!match) return null;
  const prId = Number(match[2]);
  if (!Number.isInteger(prId) || prId <= 0) return null;
  return { slug: match[1]!, prId };
}
