import type { Result } from "../result.ts";

export type WorktreeDbFlags = {
  slug?: string;
  envFile?: string;
  adminUrl?: string;
  rename: string[];
  rest: string[];
};

type WorktreeFlagDef =
  | { flag: "--slug"; field: "slug"; kind: "string" }
  | { flag: "--env-file"; field: "envFile"; kind: "string" }
  | { flag: "--admin-url"; field: "adminUrl"; kind: "string"; allowDash: true }
  | { flag: "--rename"; field: "rename"; kind: "repeat" };

const DEFS: readonly WorktreeFlagDef[] = [
  { flag: "--slug", field: "slug", kind: "string" },
  { flag: "--env-file", field: "envFile", kind: "string" },
  { flag: "--admin-url", field: "adminUrl", kind: "string", allowDash: true },
  { flag: "--rename", field: "rename", kind: "repeat" },
];

const BY_NAME = new Map(DEFS.map((d) => [d.flag, d] as const));

export type WorktreeFlagName = WorktreeFlagDef["flag"];

/** Parse worktree-db argv; does not widen the shared gateway FlagBag. */
export function parseWorktreeDbFlags(
  tokens: string[],
  allowed: readonly WorktreeFlagName[],
): Result<WorktreeDbFlags> {
  const allow = new Set<WorktreeFlagName>(allowed);
  const out: WorktreeDbFlags = { rename: [], rest: [] };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) {
      out.rest.push(token);
      continue;
    }

    const def = BY_NAME.get(token as WorktreeFlagName);
    if (!def || !allow.has(def.flag)) {
      return { ok: false, error: `unknown flag: ${token}` };
    }

    const value = tokens[++i];
    const allowDash = "allowDash" in def && def.allowDash;
    if (value === undefined || (!allowDash && value.startsWith("-"))) {
      return { ok: false, error: `missing value for ${def.flag}` };
    }

    if (def.kind === "repeat") {
      out.rename.push(value);
    } else {
      out[def.field] = value;
    }
  }

  return { ok: true, value: out };
}
