export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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

const ENV_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isCanonicalEnvKey(key: string): key is CanonicalEnvKey {
  return (CANONICAL_ENV_KEYS as readonly string[]).includes(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a preview connection-env remap map.
 * Absent or empty map → undefined (no remapping).
 * `path` prefixes error messages (e.g. "preview.env", "env").
 */
export function validatePreviewEnvMap(
  raw: unknown,
  path = "env",
): Result<PreviewEnvMap | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, error: `${path} must be a mapping` };
  }

  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: true, value: undefined };

  const env: PreviewEnvMap = {};
  const seenTargets = new Map<string, string>();

  for (const [key, value] of entries) {
    if (!isCanonicalEnvKey(key)) {
      return { ok: false, error: `unknown key: ${path}.${key}` };
    }
    if (typeof value !== "string") {
      return { ok: false, error: `${path}.${key} must be a string` };
    }
    const target = value.trim();
    if (target === "") {
      return { ok: false, error: `${path}.${key} is required` };
    }
    if (!ENV_TARGET_RE.test(target)) {
      return { ok: false, error: `${path}.${key} is invalid` };
    }
    const prior = seenTargets.get(target);
    if (prior !== undefined) {
      return {
        ok: false,
        error: `${path}: target collision: ${target}`,
      };
    }
    seenTargets.set(target, key);
    env[key] = target;
  }

  return { ok: true, value: env };
}
