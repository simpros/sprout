import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Spec #12 gateway env names that operators must see in `.env.example`. */
const V01_ENV_NAMES = [
  "SPROUT_PREVIEW_POSTGRES_URL",
  "SPROUT_PG_HOST",
  "SPROUT_PG_PORT",
  "SPROUT_PG_USER",
  "SPROUT_PG_PASSWORD",
  "SPROUT_TRAEFIK_NETWORK",
  "SPROUT_POSTGRES_NETWORK",
  "SPROUT_REGISTRY_URL",
  "SPROUT_REGISTRY_USER",
  "SPROUT_REGISTRY_PASSWORD",
  "SPROUT_ADMIN_TOKEN",
  "SPROUT_FORGE",
  "SPROUT_FORGE_TOKEN",
  "SPROUT_PORT",
  "SPROUT_TTL_HOURS",
  "SPROUT_SWEEP_MINUTES",
  "SPROUT_PREVIEW_PORT_DEFAULT",
  "SPROUT_SEED_TIMEOUT",
  "SPROUT_STATE_DB_PATH",
] as const;

function envExampleKeys(contents: string): Set<string> {
  const keys = new Set<string>();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Active assignments and commented optional pins both count as documented.
    const match = trimmed.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

describe(".env.example", () => {
  test("documents every v0.1 gateway env var name", () => {
    const path = join(import.meta.dir, "../../../.env.example");
    const keys = envExampleKeys(readFileSync(path, "utf8"));
    for (const name of V01_ENV_NAMES) {
      expect(keys.has(name), `missing ${name}`).toBe(true);
    }
  });
});