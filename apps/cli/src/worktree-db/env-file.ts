/** Logical connection fields written by worktree-db provision. */
export const DEFAULT_ENV_KEYS = {
  databaseUrl: "DATABASE_URL",
  PGHOST: "PGHOST",
  PGPORT: "PGPORT",
  PGUSER: "PGUSER",
  PGPASSWORD: "PGPASSWORD",
  PGDATABASE: "PGDATABASE",
} as const;

export type ConnectionEnvValues = {
  databaseUrl: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export type EnvKeyNames = {
  databaseUrl: string;
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
};

/** Parse KEY=VALUE rename pairs; unknown logical keys are rejected. */
export function parseEnvRenames(
  pairs: string[],
): { ok: true; value: Partial<EnvKeyNames> } | { ok: false; error: string } {
  const out: Partial<EnvKeyNames> = {};
  const logical = new Set<string>(Object.keys(DEFAULT_ENV_KEYS));
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      return {
        ok: false,
        error: `invalid --rename (expected LOGICAL=NAME): ${pair}`,
      };
    }
    const logicalKey = pair.slice(0, eq);
    const name = pair.slice(eq + 1).trim();
    if (!logical.has(logicalKey)) {
      return {
        ok: false,
        error: `unknown --rename logical key: ${logicalKey} (want ${[...logical].join(", ")})`,
      };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, error: `invalid env name in --rename: ${name}` };
    }
    out[logicalKey as keyof EnvKeyNames] = name;
  }
  return { ok: true, value: out };
}

export function resolveEnvKeyNames(
  renames: Partial<EnvKeyNames> = {},
): EnvKeyNames {
  return { ...DEFAULT_ENV_KEYS, ...renames };
}

/**
 * Replace managed connection keys in a dotenv-style file; preserve others.
 * Creates content when existing is null/empty.
 */
export function mergeConnectionEnvFile(
  existing: string | null,
  values: ConnectionEnvValues,
  names: EnvKeyNames = DEFAULT_ENV_KEYS,
): string {
  const managed = new Map<string, string>([
    [names.databaseUrl, values.databaseUrl],
    [names.PGHOST, values.host],
    [names.PGPORT, String(values.port)],
    [names.PGUSER, values.user],
    [names.PGPASSWORD, values.password],
    [names.PGDATABASE, values.database],
  ]);

  const lines: string[] = [];
  const seen = new Set<string>();

  if (existing) {
    for (const line of existing.split(/\r?\n/)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        lines.push(line);
        continue;
      }
      const eq = line.indexOf("=");
      if (eq <= 0) {
        lines.push(line);
        continue;
      }
      const key = line.slice(0, eq);
      if (managed.has(key)) {
        lines.push(`${key}=${managed.get(key)}`);
        seen.add(key);
      } else {
        lines.push(line);
      }
    }
  }

  for (const [key, value] of managed) {
    if (!seen.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  let body = lines.join("\n");
  if (!body.endsWith("\n")) body += "\n";
  return body;
}
