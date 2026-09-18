export const DB_PROVIDERS = ["postgres", "sqlite", "none"] as const;

export type DbProvider = (typeof DB_PROVIDERS)[number];

export type DbSpec = {
  provider: DbProvider;
  path: string;
  file: string;
};

export const DEFAULT_DB_PROVIDER: DbProvider = "postgres";
export const DEFAULT_DB_PATH = "/data";
export const DEFAULT_DB_FILE = "preview.db";

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

export type DbSpecIssue =
  | { code: "invalid_db_block"; detail?: string }
  | { code: "unknown_db_key"; key: string }
  | { code: "invalid_db_provider"; provider: string }
  | { code: "invalid_db_path"; path: string }
  | { code: "invalid_db_file"; file: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DB_KEYS = new Set(["provider", "path", "file"]);

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
  if (Object.keys(raw).length === 0) return { ok: true, value: undefined };
  return { ok: true, value: { provider, path, file } };
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
  }
}

export function normalizeDbSpec(spec: DbSpec | undefined): DbSpec {
  return spec ?? defaultDbSpec();
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
