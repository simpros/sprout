import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPTIONAL_ENV_DEFAULTS,
  OPTIONAL_STRING_ENV,
  REQUIRED_ENV,
} from "./config.ts";

/** Env used outside `loadConfig` (SQLite path via `resolveStateDbPath`). */
const OUT_OF_BAND_ENV = ["SPROUT_STATE_DB_PATH"] as const;

/** `.env.example` must document boot config + out-of-band operator names. */
const ENV_EXAMPLE_CATALOG: readonly string[] = [
  ...REQUIRED_ENV,
  ...Object.keys(OPTIONAL_ENV_DEFAULTS),
  ...OPTIONAL_STRING_ENV,
  "SPROUT_ADMIN_TOKEN",
  ...OUT_OF_BAND_ENV,
];

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
  test("documents every gateway env catalog name", () => {
    const path = join(import.meta.dir, "../../../.env.example");
    const keys = envExampleKeys(readFileSync(path, "utf8"));
    for (const name of ENV_EXAMPLE_CATALOG) {
      expect(keys.has(name), `missing ${name}`).toBe(true);
    }
  });
});
