import type { Result } from "./result.ts";

export type DotenvFile = { pathLabel: string; content: string };

/**
 * Expand `{placeholder}` templates in a final merged value. The returned error
 * is a bare reason (no key prefix); {@link mergeLayers} adds the key label.
 */
export type EnvValueExpander = (value: string) => Result<string>;

/** Minimal deps for reading CI / flag dotenv paths (no CLI command types). */
export type EnvFileReader = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  readTextFile: (path: string) => Promise<string | null>;
};

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

function resolveEnvPath(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}

/**
 * Collect the dotenv blob for one env surface. Order: the file-type CI
 * variable (`envVarName`, e.g. `SPROUT_APP_ENV`), then explicit `--*-env-file`
 * flags. Each value is a path GitLab writes the masked blob to; missing paths
 * fail naming the variable rather than silently dropping secrets.
 */
export async function readEnvFiles(
  deps: EnvFileReader,
  envVarName: string,
  flagPaths: string[],
  flagName: string,
): Promise<Result<DotenvFile[]>> {
  const files: DotenvFile[] = [];

  const envPath = deps.env[envVarName]?.trim();
  if (envPath) {
    const raw = await deps.readTextFile(resolveEnvPath(deps.cwd, envPath));
    if (raw === null) {
      return { ok: false, error: `cannot read ${envVarName}: ${envPath}` };
    }
    files.push({ pathLabel: `${envVarName} (${envPath})`, content: raw });
  }

  for (const filePath of flagPaths) {
    const raw = await deps.readTextFile(resolveEnvPath(deps.cwd, filePath));
    if (raw === null) {
      return { ok: false, error: `cannot read ${flagName}: ${filePath}` };
    }
    files.push({ pathLabel: filePath, content: raw });
  }

  return { ok: true, value: files };
}

/**
 * Apply `--*-env KEY=VALUE` entries into `byKey`. Errors never echo the entry:
 * it may carry a secret.
 */
function applyFlagEntries(
  byKey: Map<string, string>,
  flags: string[],
  flagLabel: string,
): Result<true> {
  for (const entry of flags) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      return { ok: false, error: `invalid ${flagLabel} (expected KEY=VALUE)` };
    }
    byKey.set(parsed.key, parsed.value);
  }
  return { ok: true, value: true };
}

/**
 * Apply dotenv text into `byKey`. Blank lines and `#` comments are skipped; an
 * optional `export ` prefix is stripped. Invalid lines fail with a path + line
 * number and never echo the line, which may carry a secret.
 */
function applyDotenv(
  byKey: Map<string, string>,
  content: string,
  pathLabel: string,
  fileFlagLabel: string,
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
    byKey.set(parsed.key, parsed.value);
  }
  return { ok: true, value: true };
}

type MergeLayersInput = {
  /** Manifest values (lowest precedence); may still contain `{placeholder}`s. */
  yamlValues?: Record<string, string>;
  files: DotenvFile[];
  flags: string[];
  flagLabel: string;
  fileFlagLabel: string;
  /** Expand each final value once after all layers merge. */
  expand?: EnvValueExpander;
  /** Prefix for expansion errors, e.g. `preview.app_env.` or `--seed-env `. */
  expandKeyPrefix: string;
};

function serializeEnv(byKey: Map<string, string>): string[] | undefined {
  if (byKey.size === 0) return undefined;
  return [...byKey].map(([key, value]) => `${key}=${value}`);
}

/**
 * Merge manifest values, then dotenv files in order, then flags. Later layers
 * overwrite duplicate keys. When `expand` is set, each final value is expanded
 * once.
 */
function mergeLayers(input: MergeLayersInput): Result<Map<string, string>> {
  const byKey = new Map(Object.entries(input.yamlValues ?? {}));
  for (const file of input.files) {
    const applied = applyDotenv(
      byKey,
      file.content,
      file.pathLabel,
      input.fileFlagLabel,
    );
    if (!applied.ok) return applied;
  }
  const flagsResult = applyFlagEntries(byKey, input.flags, input.flagLabel);
  if (!flagsResult.ok) return flagsResult;

  if (input.expand) {
    for (const [key, value] of byKey) {
      const expanded = input.expand(value);
      if (!expanded.ok) {
        return {
          ok: false,
          error: `${input.expandKeyPrefix}${key}: ${expanded.error}`,
        };
      }
      byKey.set(key, expanded.value);
    }
  }

  return { ok: true, value: byKey };
}

/**
 * Merge `preview.app_env`, then `--app-env-file` / `SPROUT_APP_ENV` contents,
 * then `--app-env` flags. Later layers overwrite duplicate keys. Required keys
 * missing after all layers fail with an app-surface error. Invalid flags /
 * file lines fail before any network call.
 */
export function mergeAppEnv(
  yamlValues: Record<string, string> | undefined,
  required: string[] | undefined,
  dotenvFiles: DotenvFile[],
  flags: string[],
  expand?: EnvValueExpander,
): Result<string[] | undefined> {
  const merged = mergeLayers({
    yamlValues,
    files: dotenvFiles,
    flags,
    flagLabel: "--app-env",
    fileFlagLabel: "--app-env-file",
    expand,
    expandKeyPrefix: "preview.app_env.",
  });
  if (!merged.ok) return merged;

  for (const key of required ?? []) {
    if (!merged.value.has(key)) {
      return {
        ok: false,
        error: `preview.app_env.${key}: required value missing (supply it via --app-env-file, SPROUT_APP_ENV, or --app-env)`,
      };
    }
  }

  return { ok: true, value: serializeEnv(merged.value) };
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
  const merged = mergeLayers({
    files: dotenvFiles,
    flags,
    flagLabel: "--seed-env",
    fileFlagLabel: "--seed-env-file",
    expand,
    expandKeyPrefix: "--seed-env ",
  });
  if (!merged.ok) return merged;
  return { ok: true, value: serializeEnv(merged.value) };
}
