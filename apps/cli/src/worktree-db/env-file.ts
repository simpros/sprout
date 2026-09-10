import {
  ENV_TARGET_RE,
  type CanonicalEnvKey,
} from "@sprout/preview-env";

/** Worktree-local emission beyond the five canonical PG* keys (ADR-0007). */
export const DATABASE_URL_LOGICAL = "DATABASE_URL" as const;

/** Owner PG* only — worktree is single-role (no companion PGAPP*). */
const WORKTREE_PG_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const satisfies readonly CanonicalEnvKey[];

export type WorktreeEnvLogicalKey =
  | typeof DATABASE_URL_LOGICAL
  | (typeof WORKTREE_PG_KEYS)[number];

/** Default env names written by worktree-db provision. */
export const DEFAULT_ENV_KEYS: Record<WorktreeEnvLogicalKey, string> = {
  DATABASE_URL: "DATABASE_URL",
  PGHOST: "PGHOST",
  PGPORT: "PGPORT",
  PGUSER: "PGUSER",
  PGPASSWORD: "PGPASSWORD",
  PGDATABASE: "PGDATABASE",
};

const WORKTREE_ENV_LOGICAL_KEYS = [
  DATABASE_URL_LOGICAL,
  ...WORKTREE_PG_KEYS,
] as const satisfies readonly WorktreeEnvLogicalKey[];

/** Connection values keyed by the same logical names as env emission (ADR-0007). */
export type ConnectionEnvValues = Record<WorktreeEnvLogicalKey, string>;

export type EnvKeyNames = Record<WorktreeEnvLogicalKey, string>;

/** Map a provision result onto logical env keys (one naming system end-to-end). */
export function connectionEnvValues(conn: {
  databaseUrl: string;
  host: string;
  port: number;
  objectName: string;
  password: string;
}): ConnectionEnvValues {
  return {
    DATABASE_URL: conn.databaseUrl,
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.objectName,
    PGPASSWORD: conn.password,
    PGDATABASE: conn.objectName,
  };
}

function isWorktreeEnvLogicalKey(key: string): key is WorktreeEnvLogicalKey {
  return (
    key === DATABASE_URL_LOGICAL ||
    (WORKTREE_PG_KEYS as readonly string[]).includes(key)
  );
}

/**
 * Parse KEY=VALUE rename pairs; unknown logical keys and target collisions
 * (same invariant as parsePreviewEnvMap / ADR-0007) are rejected.
 */
export function parseEnvRenames(
  pairs: string[],
): { ok: true; value: Partial<EnvKeyNames> } | { ok: false; error: string } {
  const out: Partial<EnvKeyNames> = {};
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
        error: `unknown --rename logical key: ${logicalKey} (want ${WORKTREE_ENV_LOGICAL_KEYS.join(", ")})`,
      };
    }
    if (!ENV_TARGET_RE.test(name)) {
      return { ok: false, error: `invalid env name in --rename: ${name}` };
    }
    out[logicalKey] = name;
  }

  const names = resolveEnvKeyNames(out);
  const seenTargets = new Map<string, WorktreeEnvLogicalKey>();
  for (const logical of WORKTREE_ENV_LOGICAL_KEYS) {
    const target = names[logical];
    const priorKey = seenTargets.get(target);
    if (priorKey !== undefined) {
      return {
        ok: false,
        error: `--rename: target collision: ${target} (${priorKey} and ${logical})`,
      };
    }
    seenTargets.set(target, logical);
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
  const managed = new Map<string, string>();
  for (const logical of WORKTREE_ENV_LOGICAL_KEYS) {
    managed.set(names[logical], values[logical]);
  }

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
