import type { Result } from "./result.ts";

export type DotenvFile = { pathLabel: string; content: string };

export type EnvValueExpander = (value: string) => Result<string>;

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

/** Missing paths fail naming the variable rather than silently dropping secrets. */
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

/** Errors never echo the entry: it may carry a secret. */
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

/** Invalid lines fail with path + line number and never echo the line, which may carry a secret. */
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
  yamlValues?: Record<string, string>;
  files: DotenvFile[];
  flags: string[];
  flagLabel: string;
  fileFlagLabel: string;
  expand?: EnvValueExpander;
  expandKeyPrefix: string;
};

function serializeEnv(byKey: Map<string, string>): string[] | undefined {
  if (byKey.size === 0) return undefined;
  return [...byKey].map(([key, value]) => `${key}=${value}`);
}

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

export type EnvSurfaceLabels = {
  flagLabel: string;
  fileFlagLabel: string;
  expandKeyPrefix: string;
  requiredPrefix: string;
  requiredHint: string;
};

export function mergeEnvSurface(
  yamlValues: Record<string, string> | undefined,
  required: string[] | undefined,
  dotenvFiles: DotenvFile[],
  flags: string[],
  expand: EnvValueExpander | undefined,
  labels: EnvSurfaceLabels,
): Result<string[] | undefined> {
  const merged = mergeLayers({
    yamlValues,
    files: dotenvFiles,
    flags,
    flagLabel: labels.flagLabel,
    fileFlagLabel: labels.fileFlagLabel,
    expand,
    expandKeyPrefix: labels.expandKeyPrefix,
  });
  if (!merged.ok) return merged;

  for (const key of required ?? []) {
    if (!merged.value.has(key)) {
      return {
        ok: false,
        error: `${labels.requiredPrefix}.${key}: required value missing (supply it via ${labels.requiredHint})`,
      };
    }
  }

  return { ok: true, value: serializeEnv(merged.value) };
}

const APP_ENV_LABELS: EnvSurfaceLabels = {
  flagLabel: "--app-env",
  fileFlagLabel: "--app-env-file",
  expandKeyPrefix: "preview.app_env.",
  requiredPrefix: "preview.app_env",
  requiredHint: "--app-env-file, SPROUT_APP_ENV, or --app-env",
};

const SEED_ENV_LABELS: EnvSurfaceLabels = {
  flagLabel: "--seed-env",
  fileFlagLabel: "--seed-env-file",
  expandKeyPrefix: "seed.env.",
  requiredPrefix: "seed.env",
  requiredHint: "--seed-env-file, SPROUT_SEED_ENV, or --seed-env",
};

export function mergeAppEnv(
  yamlValues: Record<string, string> | undefined,
  required: string[] | undefined,
  dotenvFiles: DotenvFile[],
  flags: string[],
  expand?: EnvValueExpander,
): Result<string[] | undefined> {
  return mergeEnvSurface(
    yamlValues,
    required,
    dotenvFiles,
    flags,
    expand,
    APP_ENV_LABELS,
  );
}

export function mergeSeedEnv(
  yamlValues: Record<string, string> | undefined,
  required: string[] | undefined,
  dotenvFiles: DotenvFile[],
  flags: string[],
  expand?: EnvValueExpander,
): Result<string[] | undefined> {
  return mergeEnvSurface(
    yamlValues,
    required,
    dotenvFiles,
    flags,
    expand,
    SEED_ENV_LABELS,
  );
}
