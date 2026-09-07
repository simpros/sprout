/** Gateway-owned Postgres connection fields for preview containers. */
export type AppDeployPg = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export const CANONICAL_ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

export type CanonicalEnvKey = (typeof CANONICAL_ENV_KEYS)[number];

/** Partial remap of canonical connection env names → adopter names. */
export type PreviewEnvMap = Partial<Record<CanonicalEnvKey, string>>;

const CANONICAL_ENV_KEY_SET = new Set<string>(CANONICAL_ENV_KEYS);
const ENV_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate optional deploy-body `env` remap (same rules as CLI preview.env).
 * Absent or empty → undefined (no remapping).
 */
export function resolvePreviewEnv(
  raw: Record<string, string> | undefined,
):
  | { ok: true; value: PreviewEnvMap | undefined }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: true, value: undefined };

  const env: PreviewEnvMap = {};
  const seenTargets = new Map<string, string>();

  for (const [key, value] of entries) {
    if (!CANONICAL_ENV_KEY_SET.has(key)) {
      return { ok: false, error: "unknown_env_key" };
    }
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, error: "invalid_env_target" };
    }
    const target = value.trim();
    if (!ENV_TARGET_RE.test(target)) {
      return { ok: false, error: "invalid_env_target" };
    }
    if (seenTargets.has(target)) {
      return { ok: false, error: "env_target_collision" };
    }
    seenTargets.set(target, key);
    env[key as CanonicalEnvKey] = target;
  }

  return { ok: true, value: env };
}

/**
 * Five connection vars for preview DB access (gateway-owned).
 * Optional remap replaces emitted names (no dual alias); unmapped stay PG*.
 */
export function pgConnectionEnv(
  pg: AppDeployPg,
  dbName: string,
  env?: PreviewEnvMap,
): string[] {
  const fields: [CanonicalEnvKey, string][] = [
    ["PGHOST", pg.host],
    ["PGPORT", String(pg.port)],
    ["PGUSER", pg.user],
    ["PGPASSWORD", pg.password],
    ["PGDATABASE", dbName],
  ];
  return fields.map(([key, value]) => `${env?.[key] ?? key}=${value}`);
}
