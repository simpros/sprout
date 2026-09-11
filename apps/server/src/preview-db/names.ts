import { PG_IDENT_MAX } from "@sprout/preview-db";

const SLUG_RE = /^[a-z][a-z0-9]*$/;
/**
 * Single grammar for preview DB names — build, parse, and DDL refuse-guard.
 * Lowercase only; pr id starts at 1 (no pr0).
 *
 * Length budget: companion LOGIN is `<dbName>_app` and must fit Postgres
 * NAMEDATALEN ({@link PG_IDENT_MAX}). So `dbName` max is PG_IDENT_MAX − 4.
 */
const PREVIEW_DB_NAME_RE = /^sprout_([a-z][a-z0-9]*)_pr([1-9][0-9]*)$/;

/** Max preview DB name length so `<dbName>_app` fits {@link PG_IDENT_MAX}. */
export const PREVIEW_DB_NAME_MAX = PG_IDENT_MAX - "_app".length;

export type IdentifierError =
  | "invalid_slug"
  | "invalid_pr_id"
  | "invalid_service_name";

export function validateSlug(slug: string): IdentifierError | null {
  if (!SLUG_RE.test(slug)) return "invalid_slug";
  return null;
}

/** Same grammar as slug — used for preview service names. */
export function validateServiceName(name: string): IdentifierError | null {
  if (!SLUG_RE.test(name)) return "invalid_service_name";
  return null;
}

export function validatePrId(prId: number): IdentifierError | null {
  if (!Number.isInteger(prId) || prId <= 0) return "invalid_pr_id";
  return null;
}

/**
 * Slug + pr id grammar, and composed `sprout_<slug>_pr<id>_app` fits
 * Postgres identifier length (companion role).
 */
export function validatePreviewIdentity(
  slug: string,
  prId: number,
): IdentifierError | null {
  const slugErr = validateSlug(slug);
  if (slugErr) return slugErr;
  const prErr = validatePrId(prId);
  if (prErr) return prErr;
  if (previewDbName(slug, prId).length > PREVIEW_DB_NAME_MAX) {
    return "invalid_slug";
  }
  return null;
}

/** Builds `sprout_<slug>_pr<id>` after identifiers are validated. */
export function previewDbName(slug: string, prId: number): string {
  return `sprout_${slug}_pr${prId}`;
}

export function isPreviewDbName(dbName: string): boolean {
  return (
    PREVIEW_DB_NAME_RE.test(dbName) && dbName.length <= PREVIEW_DB_NAME_MAX
  );
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
  if (datname.length > PREVIEW_DB_NAME_MAX) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}
