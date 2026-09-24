import { COMPANION_ENV_KEYS } from "./env-keys.ts";

const DB_PROVIDERS = ["postgres", "sqlite", "none"] as const;

export type DbProvider = (typeof DB_PROVIDERS)[number];

const DB_ROLES_MODES = ["single", "dual"] as const;

export type DbRolesMode = (typeof DB_ROLES_MODES)[number];

export type DbSpec = {
  provider: DbProvider;
  path: string;
  file: string;
  roles?: DbRolesMode;
};

const DEFAULT_DB_PROVIDER: DbProvider = "postgres";
const DEFAULT_DB_PATH = "/data";
const DEFAULT_DB_FILE = "preview.db";

export function defaultDbSpec(): DbSpec {
  return {
    provider: DEFAULT_DB_PROVIDER,
    path: DEFAULT_DB_PATH,
    file: DEFAULT_DB_FILE,
  };
}

export function isDbProvider(value: string): value is DbProvider {
  return (DB_PROVIDERS as readonly string[]).includes(value);
}

type DbSpecIssue =
  | { code: "invalid_db_block"; detail?: string }
  | { code: "unknown_db_key"; key: string }
  | { code: "invalid_db_provider"; provider: string }
  | { code: "invalid_db_path"; path: string }
  | { code: "invalid_db_file"; file: string }
  | { code: "invalid_db_roles"; roles: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DB_KEYS = new Set(["provider", "path", "file", "roles"]);

function isDbRolesMode(value: string): value is DbRolesMode {
  return (DB_ROLES_MODES as readonly string[]).includes(value);
}

export function parseDbSpec(
  raw: unknown,
): { ok: true; value: DbSpec | undefined } | { ok: false; issue: DbSpecIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, issue: { code: "invalid_db_block" } };
  }
  for (const key of Object.keys(raw)) {
    if (!DB_KEYS.has(key)) {
      return { ok: false, issue: { code: "unknown_db_key", key } };
    }
  }
  let provider: DbProvider = DEFAULT_DB_PROVIDER;
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !isDbProvider(raw.provider.trim())) {
      return {
        ok: false,
        issue: {
          code: "invalid_db_provider",
          provider: typeof raw.provider === "string" ? raw.provider : "",
        },
      };
    }
    provider = raw.provider.trim() as DbProvider;
  }
  let path = DEFAULT_DB_PATH;
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string") {
      return {
        ok: false,
        issue: { code: "invalid_db_path", path: "" },
      };
    }
    const trimmed = raw.path.trim();
    if (trimmed === "" || !trimmed.startsWith("/")) {
      return { ok: false, issue: { code: "invalid_db_path", path: raw.path } };
    }
    path = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  }
  let file = DEFAULT_DB_FILE;
  if (raw.file !== undefined) {
    if (
      typeof raw.file !== "string" ||
      raw.file.trim() === "" ||
      raw.file.includes("/")
    ) {
      return {
        ok: false,
        issue: {
          code: "invalid_db_file",
          file: typeof raw.file === "string" ? raw.file : "",
        },
      };
    }
    file = raw.file.trim();
  }
  let roles: DbRolesMode | undefined;
  if (raw.roles !== undefined) {
    const trimmed = typeof raw.roles === "string" ? raw.roles.trim() : "";
    if (!isDbRolesMode(trimmed)) {
      return {
        ok: false,
        issue: { code: "invalid_db_roles", roles: trimmed },
      };
    }
    roles = trimmed;
  }
  if (Object.keys(raw).length === 0) return { ok: true, value: undefined };
  return {
    ok: true,
    value: {
      provider,
      path,
      file,
      ...(roles !== undefined ? { roles } : {}),
    },
  };
}

export function dbSpecIssueMessage(issue: DbSpecIssue): string {
  switch (issue.code) {
    case "invalid_db_block":
      return "db must be a mapping";
    case "unknown_db_key":
      return `unknown key: db.${issue.key}`;
    case "invalid_db_provider":
      return `db.provider must be postgres, sqlite or none (got ${JSON.stringify(issue.provider)})`;
    case "invalid_db_path":
      return `db.path must be an absolute container path (got ${JSON.stringify(issue.path)})`;
    case "invalid_db_file":
      return `db.file must be a file name without / (got ${JSON.stringify(issue.file)})`;
    case "invalid_db_roles":
      return `db.roles must be single or dual (got ${JSON.stringify(issue.roles)})`;
  }
}

export function normalizeDbSpec(spec: DbSpec | undefined): DbSpec {
  return spec ?? defaultDbSpec();
}

/** Companion credential keys that opt a postgres preview into dual roles. */
function companionRemapKey(
  env: Record<string, string> | undefined,
): string | null {
  if (!env) return null;
  for (const key of COMPANION_ENV_KEYS) {
    if (Object.hasOwn(env, key)) return key;
  }
  return null;
}

export type DbRolesIssue =
  | { code: "db_roles_requires_provider"; provider: DbProvider }
  | { code: "db_roles_conflict"; key: string };

export function dbRolesIssueMessage(issue: DbRolesIssue): string {
  switch (issue.code) {
    case "db_roles_requires_provider":
      return `db.roles requires db.provider postgres (got ${JSON.stringify(issue.provider)})`;
    case "db_roles_conflict":
      return `preview.env.${issue.key} conflicts with db.roles single (remove the remap or use db.roles dual)`;
  }
}

/**
 * One default rule shared by the CLI parse path and the gateway deploy
 * route: explicit db.roles wins; otherwise dual when preview.env remaps a
 * companion key, else single. Non-postgres providers reject an explicit
 * roles key the same way out-of-scope env keys are rejected.
 */
export function resolveDbRoles(
  spec: DbSpec | undefined,
  env: Record<string, string> | undefined,
): { ok: true; value: DbRolesMode } | { ok: false; issue: DbRolesIssue } {
  const provider = spec?.provider ?? DEFAULT_DB_PROVIDER;
  const explicit = spec?.roles;
  if (explicit !== undefined && provider !== "postgres") {
    return {
      ok: false,
      issue: { code: "db_roles_requires_provider", provider },
    };
  }
  const remapped = companionRemapKey(env);
  if (explicit === "single" && remapped !== null) {
    return { ok: false, issue: { code: "db_roles_conflict", key: remapped } };
  }
  if (explicit !== undefined) return { ok: true, value: explicit };
  if (provider !== "postgres") return { ok: true, value: "single" };
  return { ok: true, value: remapped !== null ? "dual" : "single" };
}

/** None previews have no database: no provision, no connection env, no seed. */
export function requiresDatabase(provider: DbProvider): boolean {
  return provider !== "none";
}

export function seedRequiresDatabaseMessage(): string {
  return "seed requires db.provider postgres or sqlite (db.provider is none)";
}

export function sqliteDatabaseUrl(path: string, file: string): string {
  const dir = path.endsWith("/") ? path.slice(0, -1) : path;
  return `file:${dir}/${file}`;
}
