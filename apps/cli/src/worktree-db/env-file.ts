import {
  CANONICAL_ENV_KEYS,
  ENV_TARGET_RE,
  isCanonicalEnvKey,
  type CanonicalEnvKey,
} from "@sprout/preview-env";

/** Worktree-local emission beyond the five canonical PG* keys (ADR-0007). */
export const DATABASE_URL_LOGICAL = "DATABASE_URL" as const;

export type WorktreeEnvLogicalKey =
  | typeof DATABASE_URL_LOGICAL
  | CanonicalEnvKey;

/** Default env names written by worktree-db provision. */
export const DEFAULT_ENV_KEYS: Record<WorktreeEnvLogicalKey, string> = {
  DATABASE_URL: "DATABASE_URL",
  PGHOST: "PGHOST",
  PGPORT: "PGPORT",
  PGUSER: "PGUSER",
  PGPASSWORD: "PGPASSWORD",
  PGDATABASE: "PGDATABASE",
};

export type ConnectionEnvValues = {
  databaseUrl: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export type EnvKeyNames = Record<WorktreeEnvLogicalKey, string>;

function isWorktreeEnvLogicalKey(key: string): key is WorktreeEnvLogicalKey {
  return key === DATABASE_URL_LOGICAL || isCanonicalEnvKey(key);
}

/** Parse KEY=VALUE rename pairs; unknown logical keys are rejected. */
export function parseEnvRenames(
  pairs: string[],
): { ok: true; value: Partial<EnvKeyNames> } | { ok: false; error: string } {
  const out: Partial<EnvKeyNames> = {};
  const logical = [
    DATABASE_URL_LOGICAL,
    ...CANONICAL_ENV_KEYS,
  ] as WorktreeEnvLogicalKey[];
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
    if (!isWorktreeEnvLogicalKey(logicalKey)) {
      return {
        ok: false,
        error: `unknown --rename logical key: ${logicalKey} (want ${logical.join(", ")})`,
      };
    }
    if (!ENV_TARGET_RE.test(name)) {
      return { ok: false, error: `invalid env name in --rename: ${name}` };
    }
    out[logicalKey] = name;
  }
  return { ok: true, value: out };
}

export function resolveEnvKeyNames(
  renames: Partial<EnvKeyNames> = {},
): EnvKeyNames {
  return { ...DEFAULT_ENV_KEYS, ...renames };
}

/** Read a KEY=value from dotenv-style text (first match). */
export function readEnvFileValue(
  existing: string | null,
  key: string,
): string | undefined {
  if (!existing) return undefined;
  for (const line of existing.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return undefined;
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
    [names.DATABASE_URL, values.databaseUrl],
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
