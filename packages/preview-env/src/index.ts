import type { DbProvider } from "./db.ts";
import { envProviderMismatch, parsePreviewEnvMap } from "./env-keys.ts";
import type {
  CanonicalEnvKey,
  PreviewEnvIssue,
  PreviewEnvMap,
} from "./env-keys.ts";

export { OWNER_ENV_KEYS, PREVIEW_ENV_KEYS } from "./env-keys.ts";

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
] as const;

/** Every key preview.env accepts: database keys plus the cross-provider mail set. */
export const PREVIEW_ENV_KEYS = [...CANONICAL_ENV_KEYS, ...MAIL_ENV_KEYS] as const;

export type OwnerEnvKey = (typeof OWNER_ENV_KEYS)[number];
type CompanionEnvKey = (typeof COMPANION_ENV_KEYS)[number];
type SqliteEnvKey = (typeof SQLITE_ENV_KEYS)[number];
export type MailEnvKey = (typeof MAIL_ENV_KEYS)[number];
export type CanonicalEnvKey = (typeof CANONICAL_ENV_KEYS)[number];
export type PreviewEnvKey = CanonicalEnvKey | MailEnvKey;

type PostgresEnvKey = OwnerEnvKey | CompanionEnvKey;

export const POSTGRES_ENV_KEYS: readonly PostgresEnvKey[] = [
  ...OWNER_ENV_KEYS,
  ...COMPANION_ENV_KEYS,
] as const;

export type PreviewEnvMap = Partial<Record<PreviewEnvKey, string>>;

import { ENV_TARGET_RE } from "./services.ts";

export { ENV_TARGET_RE } from "./services.ts";

/** Total home table: every database key maps to its provider. */
export const ENV_KEY_HOME: Record<CanonicalEnvKey, DbProvider> = {
  PGHOST: "postgres",
  PGPORT: "postgres",
  PGUSER: "postgres",
  PGPASSWORD: "postgres",
  PGDATABASE: "postgres",
  PGAPPUSER: "postgres",
  PGAPPPASSWORD: "postgres",
  DATABASE_URL: "sqlite",
};

function isMailEnvKey(key: string): key is MailEnvKey {
  return (MAIL_ENV_KEYS as readonly string[]).includes(key);
}

function isPreviewEnvKey(key: string): key is PreviewEnvKey {
  return (PREVIEW_ENV_KEYS as readonly string[]).includes(key);
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
    // Mail keys live outside the db provider scope and are allowed on any provider.
    if (isMailEnvKey(key)) continue;
    const home = ENV_KEY_HOME[key as CanonicalEnvKey];
    if (home !== provider) {
      return { key: key as CanonicalEnvKey, home };
    }
  }
  return null;
}

type PreviewEnvIssue =
  | { code: "unknown_env_key"; key: string }
  | { code: "empty_env_target"; key: string }
  | { code: "invalid_env_target"; key: string }
  | {
      code: "env_target_collision";
      key: string;
      target: string;
      priorKey: string;
    };

type EnvProviderIssue = {
  code: "env_requires_provider";
  key: CanonicalEnvKey;
  home: DbProvider;
};

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

// Home modules are the intra-package contract: they may export seams (notably
// for direct-path tests) that the barrel below deliberately does not re-export.
export {
  resolveHostnameValue,
  validateHostname,
  validateHostnameValue,
  type HostnameIssue,
} from "./hostname.ts";

export {
  DEFAULT_HEALTH,
  resolveHealthSpec,
  type HealthIssue,
  type HealthRequest,
  type HealthSpec,
} from "./health.ts";

export {
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
} from "./db.ts";

export {
  parseSqliteVolumeName,
  sqliteVolumeName,
} from "./naming.ts";

export {
  labelIssueMessage,
  parseLabelMap,
  type PreviewLabels,
} from "./labels.ts";

export {
  copyServiceExtras,
  isServicePort,
  parseServiceEnvMap,
  type PreviewServiceSpec,
  type ServiceFields,
} from "./services.ts";

export {
  DEFAULT_MAIL_FROM_DOMAIN,
  deriveMailFromName,
  mailIntent,
  mailSpecIssueMessage,
  parseMailSpec,
  resolveMailIdentity,
  type MailIdentity,
  type MailSpec,
} from "./mail.ts";
