import { FORGE_KINDS, type ForgeKind } from "./forge/client.ts";

export const REQUIRED_ENV = [
  "SPROUT_PREVIEW_POSTGRES_URL",
  "SPROUT_PG_HOST",
  "SPROUT_PG_USER",
  "SPROUT_PG_PASSWORD",
  "SPROUT_TRAEFIK_NETWORK",
  "SPROUT_POSTGRES_NETWORK",
  "SPROUT_REGISTRY_URL",
  "SPROUT_FORGE",
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
  "SPROUT_FORGE_TOKEN",
] as const;

export type Config = {
  previewPostgresUrl: string;
  /** Hostname preview containers use for PGHOST (often not the admin DSN host). */
  previewPgHost: string;
  previewPgPort: number;
  previewPgUser: string;
  previewPgPassword: string;
  traefikNetwork: string;
  postgresNetwork: string;
  registryUrl: string;
  /** Empty string = anonymous registry pull. */
  registryUser: string;
  /** Empty string = anonymous registry pull. */
  registryPassword: string;
  /** Sweep-only forge API token (not used for cloning). Empty until a sweep forge call. */
  forge: ForgeKind;
  /** Empty string allowed at boot; forge API calls fail if still unset. */
  forgeToken: string;
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
  const forgeRaw = requiredEnv("SPROUT_FORGE").toLowerCase();
  if (!FORGE_KINDS.includes(forgeRaw as ForgeKind)) {
    throw new Error(
      `Invalid SPROUT_FORGE: must be one of ${FORGE_KINDS.join(", ")}`,
    );
  }

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
    registryUrl: requiredEnv("SPROUT_REGISTRY_URL"),
    registryUser: optionalStringEnv("SPROUT_REGISTRY_USER"),
    registryPassword: optionalStringEnv("SPROUT_REGISTRY_PASSWORD"),
    forge: forgeRaw as ForgeKind,
    forgeToken: optionalStringEnv("SPROUT_FORGE_TOKEN"),
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
    registryUrl: config.registryUrl,
    registryUser: config.registryUser === "" ? "[anonymous]" : config.registryUser,
    registryPassword: config.registryPassword === "" ? "[anonymous]" : "[set]",
    forge: config.forge,
    forgeToken: config.forgeToken === "" ? "[unset]" : "[set]",
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
