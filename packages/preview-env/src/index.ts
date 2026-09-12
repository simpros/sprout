/** Owner / primary connection env names (single-role surfaces). */
export const OWNER_ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

/** Restricted companion LOGIN env names (gateway dual-role injection). */
export const COMPANION_ENV_KEYS = ["PGAPPUSER", "PGAPPPASSWORD"] as const;

/** Canonical gateway-emitted connection env names (owner + companion). */
export const CANONICAL_ENV_KEYS = [
  ...OWNER_ENV_KEYS,
  ...COMPANION_ENV_KEYS,
] as const;

export type OwnerEnvKey = (typeof OWNER_ENV_KEYS)[number];
export type CompanionEnvKey = (typeof COMPANION_ENV_KEYS)[number];
export type CanonicalEnvKey = (typeof CANONICAL_ENV_KEYS)[number];

/** Partial remap of canonical connection env names → adopter names. */
export type PreviewEnvMap = Partial<Record<CanonicalEnvKey, string>>;

/** Shell-safe env name: letter/underscore start, then alnum/underscore. */
export const ENV_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isCanonicalEnvKey(key: string): key is CanonicalEnvKey {
  return (CANONICAL_ENV_KEYS as readonly string[]).includes(key);
}

export type PreviewEnvIssue =
  | { code: "unknown_env_key"; key: string }
  | { code: "empty_env_target"; key: string }
  | { code: "invalid_env_target"; key: string }
  | {
      code: "env_target_collision";
      key: string;
      target: string;
      priorKey: string;
    };

/**
 * Validate a connection-env remap map (canonical key → adopter name).
 * Absent or empty → undefined (no remapping). Values must be non-empty strings.
 */
export function parsePreviewEnvMap(
  raw: Record<string, unknown> | undefined,
):
  | { ok: true; value: PreviewEnvMap | undefined }
  | { ok: false; issue: PreviewEnvIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: true, value: undefined };

  const env: PreviewEnvMap = {};
  const seenTargets = new Map<string, string>();

  for (const [key, value] of entries) {
    if (!isCanonicalEnvKey(key)) {
      return { ok: false, issue: { code: "unknown_env_key", key } };
    }
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, issue: { code: "empty_env_target", key } };
    }
    const target = value.trim();
    if (!ENV_TARGET_RE.test(target)) {
      return { ok: false, issue: { code: "invalid_env_target", key } };
    }
    const priorKey = seenTargets.get(target);
    if (priorKey !== undefined) {
      return {
        ok: false,
        issue: {
          code: "env_target_collision",
          key,
          target,
          priorKey,
        },
      };
    }
    seenTargets.set(target, key);
    env[key] = target;
  }
  return { ok: true, value: env };
}

export {
  HOSTNAME_PLACEHOLDER,
  substituteHostname,
  validateHostname,
  validateHostnameTemplate,
  type HostnameIssue,
} from "./hostname.ts";
