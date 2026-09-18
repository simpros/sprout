export const OWNER_ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

export const COMPANION_ENV_KEYS = ["PGAPPUSER", "PGAPPPASSWORD"] as const;

export const SQLITE_ENV_KEYS = ["DATABASE_URL"] as const;

export const CANONICAL_ENV_KEYS = [
  ...OWNER_ENV_KEYS,
  ...COMPANION_ENV_KEYS,
  ...SQLITE_ENV_KEYS,
] as const;

export type OwnerEnvKey = (typeof OWNER_ENV_KEYS)[number];
export type CompanionEnvKey = (typeof COMPANION_ENV_KEYS)[number];
export type SqliteEnvKey = (typeof SQLITE_ENV_KEYS)[number];
export type CanonicalEnvKey = (typeof CANONICAL_ENV_KEYS)[number];

export type PostgresEnvKey = OwnerEnvKey | CompanionEnvKey;

export const POSTGRES_ENV_KEYS: readonly PostgresEnvKey[] = [
  ...OWNER_ENV_KEYS,
  ...COMPANION_ENV_KEYS,
] as const;

export type PreviewEnvMap = Partial<Record<CanonicalEnvKey, string>>;

export const ENV_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

import type { DbProvider } from "./db.ts";

export function isCanonicalEnvKey(key: string): key is CanonicalEnvKey {
  return (CANONICAL_ENV_KEYS as readonly string[]).includes(key);
}

export function envKeysForProvider(
  provider: DbProvider,
): readonly CanonicalEnvKey[] {
  return provider === "sqlite" ? SQLITE_ENV_KEYS : POSTGRES_ENV_KEYS;
}

export function isEnvKeyForProvider(
  key: CanonicalEnvKey,
  provider: DbProvider,
): boolean {
  return (envKeysForProvider(provider) as readonly string[]).includes(key);
}

export function providerForEnvKey(key: CanonicalEnvKey): DbProvider {
  return key === "DATABASE_URL" ? "sqlite" : "postgres";
}

export function envProviderMismatch(
  env: Partial<Record<CanonicalEnvKey, string>> | undefined,
  provider: DbProvider,
): { key: CanonicalEnvKey; home: DbProvider } | null {
  for (const key of Object.keys(env ?? {})) {
    const canonical = key as CanonicalEnvKey;
    if (!isEnvKeyForProvider(canonical, provider)) {
      return { key: canonical, home: providerForEnvKey(canonical) };
    }
  }
  return null;
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
  resolveHostnameValue,
  validateHostname,
  validateHostnameValue,
  type HostnameIssue,
  type HostnameMode,
} from "./hostname.ts";

export {
  DEFAULT_HEALTH,
  resolveHealthSpec,
  type HealthIssue,
  type HealthRequest,
  type HealthSpec,
} from "./health.ts";

export {
  DEFAULT_DB_FILE,
  DEFAULT_DB_PATH,
  DEFAULT_DB_PROVIDER,
  DB_PROVIDERS,
  dbSpecIssueMessage,
  defaultDbSpec,
  isDbProvider,
  normalizeDbSpec,
  parseDbSpec,
  resolveSqliteDatabaseUrl,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type DbSpecIssue,
} from "./db.ts";
