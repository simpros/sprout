const SLUG_RE = /^[a-z][a-z0-9]*$/;
/**
 * Single grammar for preview DB names — build, parse, and DDL refuse-guard.
 * Lowercase only; pr id starts at 1 (no pr0).
 */
const PREVIEW_DB_NAME_RE = /^sprout_([a-z][a-z0-9]*)_pr([1-9][0-9]*)$/;

export type IdentifierError = "invalid_slug" | "invalid_pr_id";

export function validateSlug(slug: string): IdentifierError | null {
  if (!SLUG_RE.test(slug)) return "invalid_slug";
  return null;
}

export function validatePrId(prId: number): IdentifierError | null {
  if (!Number.isInteger(prId) || prId <= 0) return "invalid_pr_id";
  return null;
}

/** Builds `sprout_<slug>_pr<id>` after identifiers are validated. */
export function previewDbName(slug: string, prId: number): string {
  return `sprout_${slug}_pr${prId}`;
}

export function isPreviewDbName(dbName: string): boolean {
  return PREVIEW_DB_NAME_RE.test(dbName);
}

export function assertPreviewDbName(dbName: string): void {
  if (!isPreviewDbName(dbName)) {
    throw new Error(`refusing unsafe preview database name: ${dbName}`);
  }
}

export function parsePreviewDatabaseName(
  datname: string,
): { slug: string; prId: number } | null {
  const match = PREVIEW_DB_NAME_RE.exec(datname);
  if (!match) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}
