import type { Result } from "./result.ts";

/**
 * Merge yaml `preview.app_env` with `--app-env` flags.
 * Yaml first; flags overwrite duplicate keys. Invalid flags fail before any
 * network call. Empty result → undefined (omit `app_env` on the wire).
 */
export function mergeAppEnv(
  yaml: Record<string, string> | undefined,
  flags: string[],
): Result<string[] | undefined> {
  const byKey = new Map(Object.entries(yaml ?? {}));
  for (const entry of flags) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `invalid --app-env: ${entry}` };
    }
    byKey.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  if (byKey.size === 0) return { ok: true, value: undefined };
  return {
    ok: true,
    value: [...byKey].map(([key, value]) => `${key}=${value}`),
  };
}
