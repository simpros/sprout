import type { DbProvider } from "./db.ts";

export const OWNER_ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

export const COMPANION_ENV_KEYS = ["PGAPPUSER", "PGAPPPASSWORD"] as const;

export const SQLITE_ENV_KEYS = ["DATABASE_URL"] as const;

export const MAIL_ENV_KEYS = [
  "MAILHOST",
  "MAILPORT",
  "MAILUSER",
  "MAILPASSWORD",
  "MAILSECURE",
  "MAILUIURL",
  "MAILFROM",
  "MAILFROMNAME",
  "MAILREPLYTO",
] as const;

export const CANONICAL_ENV_KEYS = [
  ...OWNER_ENV_KEYS,
  ...COMPANION_ENV_KEYS,
  ...SQLITE_ENV_KEYS,
  ...MAIL_ENV_KEYS,
] as const;

export type OwnerEnvKey = (typeof OWNER_ENV_KEYS)[number];
export type CompanionEnvKey = (typeof COMPANION_ENV_KEYS)[number];
export type SqliteEnvKey = (typeof SQLITE_ENV_KEYS)[number];
export type MailEnvKey = (typeof MAIL_ENV_KEYS)[number];
export type CanonicalEnvKey = (typeof CANONICAL_ENV_KEYS)[number];

export type PostgresEnvKey = OwnerEnvKey | CompanionEnvKey;

export const POSTGRES_ENV_KEYS: readonly PostgresEnvKey[] = [
  ...OWNER_ENV_KEYS,
  ...COMPANION_ENV_KEYS,
] as const;

export type PreviewEnvMap = Partial<Record<CanonicalEnvKey, string>>;

import { ENV_TARGET_RE } from "./services.ts";

export { ENV_TARGET_RE } from "./services.ts";

/** Single home table for every canonical key; partitions derive from it. Mail keys live outside the db provider scope and are allowed on any provider. */
export type EnvKeyHome = DbProvider | "mail";

export const ENV_KEY_HOME: Record<CanonicalEnvKey, EnvKeyHome> = {
  PGHOST: "postgres",
  PGPORT: "postgres",
  PGUSER: "postgres",
  PGPASSWORD: "postgres",
  PGDATABASE: "postgres",
  PGAPPUSER: "postgres",
  PGAPPPASSWORD: "postgres",
  DATABASE_URL: "sqlite",
  MAILHOST: "mail",
  MAILPORT: "mail",
  MAILUSER: "mail",
  MAILPASSWORD: "mail",
  MAILSECURE: "mail",
  MAILUIURL: "mail",
  MAILFROM: "mail",
  MAILFROMNAME: "mail",
  MAILREPLYTO: "mail",
};

export function isCanonicalEnvKey(key: string): key is CanonicalEnvKey {
  return (CANONICAL_ENV_KEYS as readonly string[]).includes(key);
}

export function envKeysForProvider(
  provider: DbProvider,
): readonly CanonicalEnvKey[] {
  return CANONICAL_ENV_KEYS.filter((key) => ENV_KEY_HOME[key] === provider);
}

export function envProviderMismatch(
  env: PreviewEnvMap | undefined,
  provider: DbProvider,
): { key: CanonicalEnvKey; home: DbProvider } | null {
  for (const key of Object.keys(env ?? {})) {
    const canonical = key as CanonicalEnvKey;
    const home = ENV_KEY_HOME[canonical];
    if (home === "mail") continue;
    if (home !== provider) {
      return { key: canonical, home };
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

export type EnvProviderIssue = {
  code: "env_requires_provider";
  key: CanonicalEnvKey;
  home: DbProvider;
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

/** Parse plus provider-scope check: the single entry both CLI and server call. */
export function parsePreviewEnvForProvider(
  raw: Record<string, unknown> | undefined,
  provider: DbProvider,
):
  | { ok: true; value: PreviewEnvMap | undefined }
  | { ok: false; issue: PreviewEnvIssue | EnvProviderIssue } {
  const parsed = parsePreviewEnvMap(raw);
  if (!parsed.ok) return parsed;
  const mismatch = envProviderMismatch(parsed.value, provider);
  if (mismatch) {
    return {
      ok: false,
      issue: { code: "env_requires_provider", ...mismatch },
    };
  }
  return parsed;
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
  requiresDatabase,
  seedRequiresDatabaseMessage,
  sqliteDatabaseUrl,
  type DbProvider,
  type DbSpec,
  type DbSpecIssue,
} from "./db.ts";

export {
  parseSqliteVolumeName,
  sqliteVolumeName,
} from "./naming.ts";

export {
  copyServiceExtras,
  isServicePort,
  parseServiceEnvMap,
  SERVICE_PORT_MAX,
  SERVICE_PORT_MIN,
  type PreviewServiceSpec,
  type ServiceEnvIssue,
  type ServiceFields,
} from "./services.ts";

export {
  MAIL_MODES,
  DEFAULT_MAIL_FROM_DOMAIN,
  deriveMailFrom,
  deriveMailFromName,
  isMailMode,
  mailIntent,
  mailSpecIssueMessage,
  parseMailSpec,
  resolveMailFrom,
  resolveMailIdentity,
  validateMailFromTemplate,
  type MailIdentity,
  type MailIntent,
  type MailMode,
  type MailSpec,
  type MailSpecIssue,
  type ResolvedMailIdentity,
} from "./mail.ts";
