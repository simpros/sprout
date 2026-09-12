import type { Result } from "./result.ts";

export type DotenvFile = { pathLabel: string; content: string };

/**
 * Expand `{placeholder}` templates in a value. The returned error is a bare
 * reason (no key / source prefix); callers add the offending key and source.
 */
export type EnvValueExpander = (key: string, value: string) => Result<string>;

/** A rendered key/value plus the reason when the value could not be expanded. */
type ParsedEntry = { key: string; value: string };

function parseEntry(entry: string): ParsedEntry | null {
  const eq = entry.indexOf("=");
  if (eq <= 0) return null;
  const key = entry.slice(0, eq).trim();
  if (key === "") return null;
  return { key, value: stripQuotes(entry.slice(eq + 1)) };
}

/**
 * Strip one pair of matching surrounding quotes (`KEY="a b"` → `a b`).
 * Unbalanced quotes are kept verbatim; only surrounding whitespace of the key
 * is trimmed — values keep their bytes so secrets survive round-trips.
 */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if (
      (first === '"' || first === "'") &&
      value[value.length - 1] === first
    ) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Apply `--*-env KEY=VALUE` entries into `byKey`. Values are expanded when an
 * expander is supplied. Errors never echo the entry: it may carry a secret.
 */
function applyFlagEntries(
  byKey: Map<string, string>,
  flags: string[],
  flagLabel: string,
  expand?: EnvValueExpander,
): Result<true> {
  for (const entry of flags) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      return { ok: false, error: `invalid ${flagLabel} (expected KEY=VALUE)` };
    }
    if (expand) {
      const expanded = expand(parsed.key, parsed.value);
      if (!expanded.ok) {
        return {
          ok: false,
          error: `${flagLabel} ${parsed.key}: ${expanded.error}`,
        };
      }
      byKey.set(parsed.key, expanded.value);
      continue;
    }
    byKey.set(parsed.key, parsed.value);
  }
  return { ok: true, value: true };
}

/**
 * Apply dotenv text into `byKey`. Blank lines and `#` comments are skipped; an
 * optional `export ` prefix is stripped. Values are expanded when an expander
 * is supplied. Invalid lines fail with a path + line number and never echo the
 * line, which may carry a secret.
 */
function applyDotenv(
  byKey: Map<string, string>,
  content: string,
  pathLabel: string,
  fileFlagLabel: string,
  expand?: EnvValueExpander,
): Result<true> {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }
    const parsed = parseEntry(line);
    if (!parsed) {
      return {
        ok: false,
        error: `invalid ${fileFlagLabel} ${pathLabel}:${i + 1}: expected KEY=VALUE`,
      };
    }
    if (expand) {
      const expanded = expand(parsed.key, parsed.value);
      if (!expanded.ok) {
        return {
          ok: false,
          error: `invalid ${fileFlagLabel} ${pathLabel}:${i + 1}: ${parsed.key}: ${expanded.error}`,
        };
      }
      byKey.set(parsed.key, expanded.value);
      continue;
    }
    byKey.set(parsed.key, parsed.value);
  }
  return { ok: true, value: true };
}

type MergeLayersInput = {
  /** Already-expanded manifest values (lowest precedence). */
  yamlValues?: Record<string, string>;
  /** Manifest keys declared required; must be provided by a file or flag. */
  required?: string[];
  files: DotenvFile[];
  flags: string[];
  flagLabel: string;
  fileFlagLabel: string;
  expand?: EnvValueExpander;
};

/**
 * Merge manifest values, then dotenv files in order, then flags. Later layers
 * overwrite duplicate keys. Required keys missing after all layers fail fast
 * with a named error. Empty result → undefined (omit the wire field).
 */
function mergeLayers(input: MergeLayersInput): Result<string[] | undefined> {
  const byKey = new Map(Object.entries(input.yamlValues ?? {}));
  for (const file of input.files) {
    const applied = applyDotenv(
      byKey,
      file.content,
      file.pathLabel,
      input.fileFlagLabel,
      input.expand,
    );
    if (!applied.ok) return applied;
  }
  const flagsResult = applyFlagEntries(
    byKey,
    input.flags,
    input.flagLabel,
    input.expand,
  );
  if (!flagsResult.ok) return flagsResult;

  for (const key of input.required ?? []) {
    if (!byKey.has(key)) {
      return {
        ok: false,
        error: `preview.app_env.${key}: required value missing (supply it via ${input.fileFlagLabel}, SPROUT_APP_ENV, or ${input.flagLabel})`,
      };
    }
  }

  if (byKey.size === 0) return { ok: true, value: undefined };
  return {
    ok: true,
    value: [...byKey].map(([key, value]) => `${key}=${value}`),
  };
}

/**
 * Merge `preview.app_env`, then `--app-env-file` / `SPROUT_APP_ENV` contents,
 * then `--app-env` flags. Later layers overwrite duplicate keys. Invalid
 * flags / file lines fail before any network call.
 */
export function mergeAppEnv(
  yamlValues: Record<string, string> | undefined,
  required: string[] | undefined,
  dotenvFiles: DotenvFile[],
  flags: string[],
  expand?: EnvValueExpander,
): Result<string[] | undefined> {
  return mergeLayers({
    yamlValues,
    required,
    files: dotenvFiles,
    flags,
    flagLabel: "--app-env",
    fileFlagLabel: "--app-env-file",
    expand,
  });
}

/**
 * Merge `--seed-env-file` / `SPROUT_SEED_ENV` contents, then `--seed-env` flags.
 * Seed has no manifest layer until the `seed.env` block lands (#124).
 */
export function mergeSeedEnv(
  dotenvFiles: DotenvFile[],
  flags: string[],
  expand?: EnvValueExpander,
): Result<string[] | undefined> {
  return mergeLayers({
    files: dotenvFiles,
    flags,
    flagLabel: "--seed-env",
    fileFlagLabel: "--seed-env-file",
    expand,
  });
}
