import type {
  TraefikForwardAuth,
  TraefikTls,
} from "./app-deployment/labels.ts";
import { DEFAULT_MAIL_FROM_DOMAIN } from "@sprout/preview-env";
import { GITHUB_HOSTS } from "./forge/kind.ts";
import {
  buildRegistryPullAuth,
  type RegistryPullAuth,
} from "./registry-auth.ts";

export const REQUIRED_ENV = ["SPROUT_TRAEFIK_NETWORK"] as const;

export const POSTGRES_REQUIRED_ENV = [
  "SPROUT_PREVIEW_POSTGRES_URL",
  "SPROUT_PG_HOST",
  "SPROUT_PG_USER",
  "SPROUT_PG_PASSWORD",
  "SPROUT_POSTGRES_NETWORK",
] as const;

export const MAIL_ENV_KEYS = [
  "SPROUT_MAIL_HOST",
  "SPROUT_MAIL_PORT",
  "SPROUT_MAIL_USER",
  "SPROUT_MAIL_PASSWORD",
  "SPROUT_MAIL_SECURE",
  "SPROUT_MAIL_NETWORK",
  "SPROUT_MAIL_UI_URL",
  "SPROUT_MAIL_FROM_DOMAIN",
] as const;

/** Port/domain always carry compose defaults; they count as intent only when non-default. */
const MAIL_DEFAULTED_KEYS = ["SPROUT_MAIL_PORT", "SPROUT_MAIL_FROM_DOMAIN"] as const;

/** Presence means operator intent; derived from MAIL_ENV_KEYS so the two cannot drift. */
const MAIL_INTENT_KEYS: (typeof MAIL_ENV_KEYS)[number][] =
  MAIL_ENV_KEYS.filter(
    (key) =>
      !(MAIL_DEFAULTED_KEYS as readonly string[]).includes(key),
  );

export const OPTIONAL_ENV_DEFAULTS = {
  SPROUT_PG_PORT: 5432,
  SPROUT_MAIL_PORT: 1025,
  SPROUT_TTL_HOURS: 72,
  SPROUT_SWEEP_MINUTES: 30,
  SPROUT_PREVIEW_PORT_DEFAULT: 8080,
  SPROUT_SEED_TIMEOUT: 180,
  SPROUT_PORT: 7331,
} as const;

export const OPTIONAL_STRING_ENV = [
  "SPROUT_REGISTRY_USER",
  "SPROUT_REGISTRY_PASSWORD",
  "SPROUT_REGISTRY_AUTHS_JSON",
  "SPROUT_GITHUB_TOKEN",
  "SPROUT_GITLAB_TOKEN",
  "SPROUT_FORGE_HOSTS",
  "SPROUT_TRAEFIK_ENTRYPOINTS",
  "SPROUT_TRAEFIK_CERTRESOLVER",
  "SPROUT_TRAEFIK_MIDDLEWARES",
  "SPROUT_FORWARDAUTH_ADDRESS",
] as const;

export const GATEWAY_ENV_DOC_KEYS: readonly string[] = [
  ...REQUIRED_ENV,
  ...POSTGRES_REQUIRED_ENV,
  ...MAIL_ENV_KEYS,
  ...Object.keys(OPTIONAL_ENV_DEFAULTS),
  ...OPTIONAL_STRING_ENV,
  "SPROUT_ADMIN_TOKEN",
  "SPROUT_STATE_DB_PATH",
  "SPROUT_ADMIN_TOKEN_PATH",
];

export type PostgresConfig = {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  network: string;
};

export type MailConfig = {
  host: string;
  port: number;
  user?: string;
  password?: string;
  secure: boolean;
  network?: string;
  uiUrl?: string;
  fromDomain: string;
};

export type Config = {
  /** Absent on sqlite-only gateways; all-or-nothing (partial fails boot). */
  postgres?: PostgresConfig;
  /** Absent when no SPROUT_MAIL_* is set; host enables, rest default. */
  mail?: MailConfig;
  traefikNetwork: string;
  registryPullAuth: RegistryPullAuth;
  githubToken: string;
  gitlabToken: string;
  extraGitlabHosts: ReadonlySet<string>;
  adminToken?: string;
  ttlHours: number;
  sweepMinutes: number;
  previewPortDefault: number;
  seedTimeout: number;
  port: number;
  traefikTls?: TraefikTls;
  traefikForwardAuth?: TraefikForwardAuth;
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

function optionalEnv(
  key:
    | (typeof OPTIONAL_STRING_ENV)[number]
    | (typeof POSTGRES_REQUIRED_ENV)[number]
    | (typeof MAIL_ENV_KEYS)[number],
): string {
  return process.env[key]?.trim() ?? "";
}

function parseMailSecure(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "" ) return false;
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  throw new Error(
    "Invalid SPROUT_MAIL_SECURE: must be a boolean (true/false, 1/0, yes/no)",
  );
}

/** Mail is host-enabled: any SPROUT_MAIL_* without a host fails boot naming the host. */
function parseMailConfig(): MailConfig | undefined {
  const host = optionalEnv("SPROUT_MAIL_HOST");
  const portRaw = optionalEnv("SPROUT_MAIL_PORT");
  const user = optionalEnv("SPROUT_MAIL_USER");
  const password = optionalEnv("SPROUT_MAIL_PASSWORD");
  const secureRaw = optionalEnv("SPROUT_MAIL_SECURE");
  const network = optionalEnv("SPROUT_MAIL_NETWORK");
  const uiUrl = optionalEnv("SPROUT_MAIL_UI_URL");
  const fromDomainRaw = optionalEnv("SPROUT_MAIL_FROM_DOMAIN");
  const portIsIntent =
    portRaw !== "" &&
    portRaw !== String(OPTIONAL_ENV_DEFAULTS.SPROUT_MAIL_PORT);
  const domainIsIntent =
    fromDomainRaw !== "" && fromDomainRaw !== DEFAULT_MAIL_FROM_DOMAIN;
  const anySet =
    MAIL_INTENT_KEYS.some((key) => optionalEnv(key) !== "") ||
    portIsIntent ||
    domainIsIntent;
  if (!anySet) return undefined;
  if (host === "") {
    throw new Error(
      "Incomplete mail configuration: missing SPROUT_MAIL_HOST",
    );
  }
  return {
    host,
    port: parsePositiveInt(
      "SPROUT_MAIL_PORT",
      portRaw === "" ? undefined : portRaw,
      OPTIONAL_ENV_DEFAULTS.SPROUT_MAIL_PORT,
    ),
    ...(user === "" ? {} : { user }),
    ...(password === "" ? {} : { password }),
    secure: parseMailSecure(secureRaw),
    ...(network === "" ? {} : { network }),
    ...(uiUrl === "" ? {} : { uiUrl }),
    fromDomain: fromDomainRaw === "" ? DEFAULT_MAIL_FROM_DOMAIN : fromDomainRaw,
  };
}

function parseTraefikTls(): TraefikTls | undefined {
  const entrypoints = optionalEnv("SPROUT_TRAEFIK_ENTRYPOINTS");
  if (entrypoints === "") return undefined;
  const certResolver = optionalEnv("SPROUT_TRAEFIK_CERTRESOLVER");
  return certResolver === ""
    ? { entrypoints }
    : { entrypoints, certResolver };
}

function parseTraefikForwardAuth(): TraefikForwardAuth | undefined {
  const middleware = optionalEnv("SPROUT_TRAEFIK_MIDDLEWARES");
  const address = optionalEnv("SPROUT_FORWARDAUTH_ADDRESS");
  if (middleware === "" && address === "") return undefined;
  if (middleware === "" || address === "") {
    throw new Error(
      "SPROUT_TRAEFIK_MIDDLEWARES and SPROUT_FORWARDAUTH_ADDRESS must both be set (or both empty)",
    );
  }
  if (middleware.includes(",")) {
    throw new Error(
      "SPROUT_TRAEFIK_MIDDLEWARES must be a single Traefik middleware name (no commas)",
    );
  }
  return { middleware, address };
}

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

/** Postgres is all-or-nothing: partial sets fail boot instead of limping. */
function parsePostgresConfig(): PostgresConfig | undefined {
  const values = {
    url: optionalEnv("SPROUT_PREVIEW_POSTGRES_URL"),
    host: optionalEnv("SPROUT_PG_HOST"),
    user: optionalEnv("SPROUT_PG_USER"),
    password: optionalEnv("SPROUT_PG_PASSWORD"),
    network: optionalEnv("SPROUT_POSTGRES_NETWORK"),
  };
  const set = (
    Object.entries(values) as [keyof typeof values, string][]
  ).filter(([, value]) => value !== "");
  if (set.length === 0) return undefined;
  if (set.length !== POSTGRES_REQUIRED_ENV.length) {
    const have = new Set(set.map(([key]) => key));
    const keyFor: Record<keyof typeof values, string> = {
      url: "SPROUT_PREVIEW_POSTGRES_URL",
      host: "SPROUT_PG_HOST",
      user: "SPROUT_PG_USER",
      password: "SPROUT_PG_PASSWORD",
      network: "SPROUT_POSTGRES_NETWORK",
    };
    const missing = (Object.keys(values) as (keyof typeof values)[])
      .filter((key) => !have.has(key))
      .map((key) => keyFor[key]);
    throw new Error(
      `Incomplete Postgres configuration: missing ${missing.join(", ")}`,
    );
  }
  return {
    ...values,
    port: parsePositiveInt(
      "SPROUT_PG_PORT",
      process.env.SPROUT_PG_PORT,
      OPTIONAL_ENV_DEFAULTS.SPROUT_PG_PORT,
    ),
  };
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
    authsJson: optionalEnv("SPROUT_REGISTRY_AUTHS_JSON"),
    legacyUser: optionalEnv("SPROUT_REGISTRY_USER"),
    legacyPassword: optionalEnv("SPROUT_REGISTRY_PASSWORD"),
  });

  return {
    postgres: parsePostgresConfig(),
    mail: parseMailConfig(),
    traefikNetwork: requiredEnv("SPROUT_TRAEFIK_NETWORK"),
    registryPullAuth,
    githubToken: optionalEnv("SPROUT_GITHUB_TOKEN"),
    gitlabToken: optionalEnv("SPROUT_GITLAB_TOKEN"),
    extraGitlabHosts: parseExtraGitlabHosts(
      optionalEnv("SPROUT_FORGE_HOSTS"),
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
    traefikTls: parseTraefikTls(),
    traefikForwardAuth: parseTraefikForwardAuth(),
  };
}

export function missingPostgresEnv(
  postgres: PostgresConfig | undefined,
): string[] {
  return postgres ? [] : [...POSTGRES_REQUIRED_ENV];
}

export function isPostgresConfigured(
  postgres: PostgresConfig | undefined,
): boolean {
  return postgres !== undefined;
}

export function postgresNotConfiguredDetail(
  postgres: PostgresConfig | undefined,
  repo: string,
): string {
  const missing = missingPostgresEnv(postgres);
  return (
    `repo ${repo} declares db.provider postgres but the gateway has no Postgres configured: ` +
    `missing ${missing.join(", ")}`
  );
}

export function mailNotConfiguredDetail(repo: string): string {
  return (
    `repo ${repo} declares mail enabled but the gateway has no mail configured: ` +
    `missing SPROUT_MAIL_HOST`
  );
}

export function configSummary(config: Config): Record<string, string | number> {
  const pg = config.postgres;
  const mail = config.mail;
  return {
    previewPostgresUrl: pg ? redactUrl(pg.url) : "[unset]",
    previewPgHost: pg ? pg.host : "[unset]",
    previewPgPort: pg ? pg.port : "[unset]",
    previewPgUser: pg ? pg.user : "[unset]",
    previewPgPassword: pg ? "[set]" : "[empty]",
    traefikNetwork: config.traefikNetwork,
    postgresNetwork: pg ? pg.network : "[unset]",
    previewMailHost: mail ? mail.host : "[unset]",
    previewMailPort: mail ? mail.port : "[unset]",
    previewMailUser: mail?.user ?? "[unset]",
    previewMailSecure: mail ? String(mail.secure) : "[unset]",
    mailNetwork: mail?.network ?? "[unset]",
    mailUiUrl: mail?.uiUrl ?? "[unset]",
    mailFromDomain: mail ? mail.fromDomain : "[unset]",
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
    traefikTls: formatTraefikTlsSummary(config.traefikTls),
    traefikForwardAuth: formatTraefikForwardAuthSummary(
      config.traefikForwardAuth,
    ),
  };
}

function formatTraefikTlsSummary(tls: TraefikTls | undefined): string {
  if (!tls) return "[unset]";
  if (tls.certResolver === undefined) return tls.entrypoints;
  return `${tls.entrypoints} (certresolver=${tls.certResolver})`;
}

function formatTraefikForwardAuthSummary(
  policy: TraefikForwardAuth | undefined,
): string {
  if (!policy) return "[unset]";
  return `${policy.middleware} → ${policy.address}`;
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
