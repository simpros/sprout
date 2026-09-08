import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_ENV_DOC_KEYS } from "./config.ts";

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
    for (const name of GATEWAY_ENV_DOC_KEYS) {
      expect(keys.has(name), `missing ${name}`).toBe(true);
    }
  });
});
