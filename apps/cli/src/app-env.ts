import type { Result } from "./result.ts";

function applyFlagEntries(
  byKey: Map<string, string>,
  flags: string[],
): Result<true> {
  for (const entry of flags) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `invalid --app-env: ${entry}` };
    }
    byKey.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return { ok: true, value: true };
}

/**
 * Apply dotenv text into `byKey`. Blank lines and `#` comments are skipped.
 * Invalid lines fail with a path-labelled error (1-based line number).
 */
function applyDotenv(
  byKey: Map<string, string>,
  content: string,
  pathLabel: string,
): Result<true> {
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
    byKey.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { ok: true, value: true };
}

export type DotenvFile = { pathLabel: string; content: string };

/**
 * Merge yaml `preview.app_env`, then `--app-env-file` contents, then
 * `--app-env` flags. Later layers overwrite duplicate keys. Invalid flags /
 * file lines fail before any network call. Empty result → undefined (omit
 * `app_env`).
 */
export function mergeAppEnv(
  yaml: Record<string, string> | undefined,
  dotenvFiles: DotenvFile[],
  flags: string[],
): Result<string[] | undefined> {
  const byKey = new Map(Object.entries(yaml ?? {}));
  for (const file of dotenvFiles) {
    const r = applyDotenv(byKey, file.content, file.pathLabel);
    if (!r.ok) return r;
  }
  const flagsResult = applyFlagEntries(byKey, flags);
  if (!flagsResult.ok) return flagsResult;
  if (byKey.size === 0) return { ok: true, value: undefined };
  return {
    ok: true,
    value: [...byKey].map(([key, value]) => `${key}=${value}`),
  };
}
