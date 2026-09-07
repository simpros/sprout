import {
  CANONICAL_ENV_KEYS,
  parsePreviewEnvMap,
  type CanonicalEnvKey,
  type PreviewEnvMap,
} from "@sprout/preview-env";

export type { CanonicalEnvKey, PreviewEnvMap };
export { CANONICAL_ENV_KEYS };

/** Gateway-owned Postgres connection fields for preview containers. */
export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

/**
 * Validate optional deploy-body `env` remap via shared preview-env rules.
 * Absent or empty → undefined (no remapping). Maps issues to API error codes.
 */
export function resolvePreviewEnv(
  raw: Record<string, string> | undefined,
):
  | { ok: true; value: PreviewEnvMap | undefined }
  | { ok: false; error: string } {
  const parsed = parsePreviewEnvMap(raw);
  if (!parsed.ok) return { ok: false, error: parsed.issue.code };
  return { ok: true, value: parsed.value };
}

/**
 * Five connection vars for preview DB access (gateway-owned).
 * Optional remap replaces emitted names (no dual alias); unmapped stay PG*.
 */
export function pgConnectionEnv(
  pg: AppDeployPg,
  dbName: string,
  connectionEnv?: PreviewEnvMap,
): string[] {
  const fields: [CanonicalEnvKey, string][] = [
    ["PGHOST", pg.host],
    ["PGPORT", String(pg.port)],
    ["PGUSER", pg.user],
    ["PGPASSWORD", pg.password],
    ["PGDATABASE", dbName],
  ];
  return fields.map(
    ([key, value]) => `${connectionEnv?.[key] ?? key}=${value}`,
  );
}
