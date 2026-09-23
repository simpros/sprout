import type { DbProvider } from "./db.ts";
import { envProviderMismatch, parsePreviewEnvMap } from "./env-keys.ts";
import type {
  CanonicalEnvKey,
  PreviewEnvIssue,
  PreviewEnvMap,
} from "./env-keys.ts";

export { OWNER_ENV_KEYS, PREVIEW_ENV_KEYS } from "./env-keys.ts";

export type {
  CanonicalEnvKey,
  MailEnvKey,
  OwnerEnvKey,
  PreviewEnvKey,
  PreviewEnvMap,
} from "./env-keys.ts";

export { ENV_TARGET_RE } from "./services.ts";

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
