import type { Result } from "./result.ts";

/**
 * Parse dotenv text into `KEY=VALUE` entries (same shape as `--app-env`).
 * Blank lines and `#` comments are skipped. Invalid lines fail with a
 * path-labelled error (and optional 1-based line number).
 */
export function parseDotenv(
  content: string,
  pathLabel: string,
): Result<string[]> {
  const entries: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      return {
        ok: false,
        error: `invalid --app-env-file ${pathLabel}:${i + 1}: ${line}`,
      };
    }
    entries.push(line);
  }
  return { ok: true, value: entries };
}

function applyKvEntries(
  byKey: Map<string, string>,
  entries: string[],
  invalidError: (entry: string) => string,
): Result<true> {
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: invalidError(entry) };
    }
    byKey.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return { ok: true, value: true };
}

/**
 * Merge yaml `preview.app_env`, then `--app-env-file` entries (already parsed),
 * then `--app-env` flags. Later layers overwrite duplicate keys. Invalid flags
 * fail before any network call. Empty result → undefined (omit `app_env`).
 */
export function mergeAppEnv(
  yaml: Record<string, string> | undefined,
  fromFiles: string[],
  flags: string[],
): Result<string[] | undefined> {
  const byKey = new Map(Object.entries(yaml ?? {}));
  const files = applyKvEntries(
    byKey,
    fromFiles,
    (entry) => `invalid --app-env-file entry: ${entry}`,
  );
  if (!files.ok) return files;
  const flagResult = applyKvEntries(
    byKey,
    flags,
    (entry) => `invalid --app-env: ${entry}`,
  );
  if (!flagResult.ok) return flagResult;
  if (byKey.size === 0) return { ok: true, value: undefined };
  return {
    ok: true,
    value: [...byKey].map(([key, value]) => `${key}=${value}`),
  };
}

/** Resolve `--app-env-file` paths relative to the CLI working directory. */
export function resolveAppEnvFilePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${cwd}/${path}`;
}
