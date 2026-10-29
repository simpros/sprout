import { COMPANION_ROLE_SUFFIX, PG_IDENT_MAX, previewDbName } from "@sprout/preview-db";
import { SERVICE_NAME_RE, type DbRolesMode } from "@sprout/preview-env";

export { previewDbName };

const PREVIEW_DB_NAME_RE = /^sprout_([a-z][a-z0-9]*)_pr([1-9][0-9]*)$/;

/** Max dbName length so <dbName>_app fits Postgres NAMEDATALEN (dual mode). */
export const PREVIEW_DB_NAME_MAX = PG_IDENT_MAX - COMPANION_ROLE_SUFFIX.length;

/** Single mode has no _app suffix, so the full identifier budget applies. */
export const PREVIEW_DB_NAME_MAX_SINGLE = PG_IDENT_MAX;

export type IdentifierError =
  | "invalid_slug"
  | "invalid_pr_id"
  | "invalid_service_name";

function validateName(value: string, error: IdentifierError): IdentifierError | null {
  return SERVICE_NAME_RE.test(value) ? null : error;
}

export function validateSlug(slug: string): IdentifierError | null {
  return validateName(slug, "invalid_slug");
}

export function validateServiceName(name: string): IdentifierError | null {
  return validateName(name, "invalid_service_name");
}

export function validatePrId(prId: number): IdentifierError | null {
  if (!Number.isInteger(prId) || prId <= 0) return "invalid_pr_id";
  return null;
}

export function validatePreviewIdentity(
  slug: string,
  prId: number,
  roles: DbRolesMode,
): IdentifierError | null {
  const slugErr = validateSlug(slug);
  if (slugErr) return slugErr;
  const prErr = validatePrId(prId);
  if (prErr) return prErr;
  const max =
    roles === "single" ? PREVIEW_DB_NAME_MAX_SINGLE : PREVIEW_DB_NAME_MAX;
  if (previewDbName(slug, prId).length > max) {
    return "invalid_slug";
  }
  return null;
}

/** Reads take no mode: a row created while `single` may run to `PG_IDENT_MAX`, so list/teardown must accept the full budget or a later flip to `dual` strands it. */
export function isPreviewDbName(dbName: string): boolean {
  return (
    PREVIEW_DB_NAME_RE.test(dbName) &&
    dbName.length <= PREVIEW_DB_NAME_MAX_SINGLE
  );
}

export function assertPreviewDbName(dbName: string): void {
  if (!isPreviewDbName(dbName)) {
    throw new Error(`refusing unsafe preview database name: ${dbName}`);
  }
}

/** Same permissive budget as isPreviewDbName (see above): reads take no mode. */
export function parsePreviewDatabaseName(
  datname: string,
): { slug: string; prId: number } | null {
  const match = PREVIEW_DB_NAME_RE.exec(datname);
  if (!match) return null;
  if (datname.length > PREVIEW_DB_NAME_MAX_SINGLE) return null;
  return { slug: match[1]!, prId: Number(match[2]) };
}
