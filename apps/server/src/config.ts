import { GITHUB_HOSTS } from "./forge/kind.ts";
import {
  buildRegistryPullAuth,
  type RegistryPullAuth,
} from "./registry-auth.ts";

export const REQUIRED_ENV = [
  "SPROUT_PREVIEW_POSTGRES_URL",
  "SPROUT_PG_HOST",
  "SPROUT_PG_USER",
  "SPROUT_PG_PASSWORD",
  "SPROUT_TRAEFIK_NETWORK",
  "SPROUT_POSTGRES_NETWORK",
] as const;

export const OPTIONAL_ENV_DEFAULTS = {
  SPROUT_PG_PORT: 5432,
  SPROUT_TTL_HOURS: 72,
  SPROUT_SWEEP_MINUTES: 30,
  SPROUT_PREVIEW_PORT_DEFAULT: 8080,
  SPROUT_SEED_TIMEOUT: 180,
  SPROUT_PORT: 7331,
} as const;

/** Optional string keys read by `loadConfig` (blank → ""). */
export const OPTIONAL_STRING_ENV = [
  "SPROUT_REGISTRY_USER",
  "SPROUT_REGISTRY_PASSWORD",
  "SPROUT_REGISTRY_AUTHS_JSON",
  "SPROUT_GITHUB_TOKEN",
  "SPROUT_GITLAB_TOKEN",
  "SPROUT_FORGE_HOSTS",
] as const;

/**
 * Every gateway env name that `.env.example` must document.
 * Includes loadConfig keys plus admin (absent vs blank) and SQLite path
 * (resolved outside loadConfig via `resolveStateDbPath`).
 */
export const GATEWAY_ENV_DOC_KEYS: readonly string[] = [
  ...REQUIRED_ENV,
  ...Object.keys(OPTIONAL_ENV_DEFAULTS),
  ...OPTIONAL_STRING_ENV,
  "SPROUT_ADMIN_TOKEN",
  "SPROUT_STATE_DB_PATH",
];

export type Config = {
  previewPostgresUrl: string;
  /** Hostname preview containers use for PGHOST (often not the admin DSN host). */
  previewPgHost: string;
  previewPgPort: number;
  previewPgUser: string;
  previewPgPassword: string;
  traefikNetwork: string;
  postgresNetwork: string;
  /**
   * Normalized registry pull auth: per-host map from SPROUT_REGISTRY_AUTHS_JSON
   * plus optional legacy USER/PASSWORD fallback (only when user is non-empty).
   */
  registryPullAuth: RegistryPullAuth;
  /** GitHub PAT for sweep open-PR listing. */
  githubToken: string;
  /** GitLab PAT for sweep open-MR listing. */
  gitlabToken: string;
  /** Extra self-managed GitLab hosts (from SPROUT_FORGE_HOSTS). */
  extraGitlabHosts: ReadonlySet<string>;
  adminToken?: string;
  ttlHours: number;
  sweepMinutes: number;
  previewPortDefault: number;
  seedTimeout: number;
  port: number;
};

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  return value;
}

function requiredEnv(key: (typeof REQUIRED_ENV)[number]): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw.trim();
}

/** Trimmed env value; missing or blank → "". */
function optionalStringEnv(key: (typeof OPTIONAL_STRING_ENV)[number]): string {
  return process.env[key]?.trim() ?? "";
}

/**
 * Parse `host=gitlab` pairs (also accepts `host:gitlab`) into extra GitLab hosts.
 * Built-in GitHub hosts cannot be remapped. Empty / unset → empty set.
 */
export function parseExtraGitlabHosts(raw: string): ReadonlySet<string> {
  const trimmed = raw.trim();
  if (trimmed === "") return new Set();
  const out = new Set<string>();
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const sep = entry.includes("=") ? "=" : entry.includes(":") ? ":" : null;
    if (!sep) {
      throw new Error(
        `Invalid SPROUT_FORGE_HOSTS entry "${entry}": expected host=gitlab`,
      );
    }
    const [hostRaw, kindRaw] = entry.split(sep, 2);
    const host = hostRaw?.trim().toLowerCase() ?? "";
    const kind = kindRaw?.trim().toLowerCase() ?? "";
    if (!host || kind !== "gitlab") {
      throw new Error(
        `Invalid SPROUT_FORGE_HOSTS entry "${entry}": expected host=gitlab (custom hosts → GitLab only; github.com is inferred)`,
      );
    }
    if (GITHUB_HOSTS.has(host)) {
      throw new Error(
        `Invalid SPROUT_FORGE_HOSTS entry "${entry}": ${host} is a built-in GitHub host and cannot be remapped`,
      );
    }
    out.add(host);
  }
  return out;
}

export function loadConfig(): Config {
  const missing = REQUIRED_ENV.filter((key) => {
    const raw = process.env[key];
    return raw === undefined || raw.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  const adminTokenRaw = process.env.SPROUT_ADMIN_TOKEN?.trim();

  const registryPullAuth = buildRegistryPullAuth({
    authsJson: optionalStringEnv("SPROUT_REGISTRY_AUTHS_JSON"),
    legacyUser: optionalStringEnv("SPROUT_REGISTRY_USER"),
    legacyPassword: optionalStringEnv("SPROUT_REGISTRY_PASSWORD"),
  });

  return {
    previewPostgresUrl: requiredEnv("SPROUT_PREVIEW_POSTGRES_URL"),
    previewPgHost: requiredEnv("SPROUT_PG_HOST"),
    previewPgPort: parsePositiveInt(
      "SPROUT_PG_PORT",
      process.env.SPROUT_PG_PORT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PG_PORT,
    ),
    previewPgUser: requiredEnv("SPROUT_PG_USER"),
    previewPgPassword: requiredEnv("SPROUT_PG_PASSWORD"),
    traefikNetwork: requiredEnv("SPROUT_TRAEFIK_NETWORK"),
    postgresNetwork: requiredEnv("SPROUT_POSTGRES_NETWORK"),
    registryPullAuth,
    githubToken: optionalStringEnv("SPROUT_GITHUB_TOKEN"),
    gitlabToken: optionalStringEnv("SPROUT_GITLAB_TOKEN"),
    extraGitlabHosts: parseExtraGitlabHosts(
      optionalStringEnv("SPROUT_FORGE_HOSTS"),
    ),
    adminToken: adminTokenRaw === "" ? undefined : adminTokenRaw,
    ttlHours: parsePositiveInt(
      "SPROUT_TTL_HOURS",
      process.env.SPROUT_TTL_HOURS,
      OPTIONAL_ENV_DEFAULTS.SPROUT_TTL_HOURS,
    ),
    sweepMinutes: parsePositiveInt(
      "SPROUT_SWEEP_MINUTES",
      process.env.SPROUT_SWEEP_MINUTES,
      OPTIONAL_ENV_DEFAULTS.SPROUT_SWEEP_MINUTES,
    ),
    previewPortDefault: parsePositiveInt(
      "SPROUT_PREVIEW_PORT_DEFAULT",
      process.env.SPROUT_PREVIEW_PORT_DEFAULT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PREVIEW_PORT_DEFAULT,
    ),
    seedTimeout: parsePositiveInt(
      "SPROUT_SEED_TIMEOUT",
      process.env.SPROUT_SEED_TIMEOUT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_SEED_TIMEOUT,
    ),
    port: parsePositiveInt(
      "SPROUT_PORT",
      process.env.SPROUT_PORT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PORT,
    ),
  };
}

export function configSummary(config: Config): Record<string, string | number> {
  return {
    previewPostgresUrl: redactUrl(config.previewPostgresUrl),
    previewPgHost: config.previewPgHost,
    previewPgPort: config.previewPgPort,
    previewPgUser: config.previewPgUser,
    previewPgPassword: config.previewPgPassword === "" ? "[empty]" : "[set]",
    traefikNetwork: config.traefikNetwork,
    postgresNetwork: config.postgresNetwork,
    registryPullAuthHosts: config.registryPullAuth.byHost.size,
    registryPullAuthFallback: config.registryPullAuth.fallback
      ? "[set]"
      : "[unset]",
    githubToken: config.githubToken === "" ? "[unset]" : "[set]",
    gitlabToken: config.gitlabToken === "" ? "[unset]" : "[set]",
    extraGitlabHosts: config.extraGitlabHosts.size,
    ttlHours: config.ttlHours,
    sweepMinutes: config.sweepMinutes,
    previewPortDefault: config.previewPortDefault,
    seedTimeout: config.seedTimeout,
    port: config.port,
  };
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "[invalid url]";
  }
}
