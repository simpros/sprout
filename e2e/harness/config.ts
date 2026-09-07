/** Thin process-env reader for the e2e smoke harness.
 *
 * `gatewayUrl` / `adminToken` are injected by `e2e/run.ts` (from
 * `compose.e2e.env`). Empty when unmanaged — compose suites skip, so nothing
 * runs against an empty URL.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_COMPOSE_PROJECT = "sprout-e2e";

export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const COMPOSE_E2E_ENV_PATH = join(repoRoot, "e2e/compose.e2e.env");

export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function requireComposeEnv(
  env: Record<string, string>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`e2e/compose.e2e.env missing required key ${key}`);
  }
  return value;
}

export const e2eConfig = {
  /** Injected by run.ts; empty when unmanaged (nothing runs). */
  get gatewayUrl() {
    return process.env.SPROUT_E2E_GATEWAY_URL?.trim() || "";
  },
  /** Injected by run.ts; empty when unmanaged (nothing runs). */
  get adminToken() {
    return process.env.SPROUT_E2E_ADMIN_TOKEN?.trim() || "";
  },
  slug: "demoapp",
  canonicalRepoId: "https://github.com/sprout/e2e-demo",
};
