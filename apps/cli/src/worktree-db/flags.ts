import { parseArgv, type ArgvFlagDef } from "../flags.ts";
import type { Result } from "../result.ts";

export type WorktreeDbFlags = {
  slug?: string;
  envFile?: string;
  adminUrl?: string;
  rename: string[];
  rest: string[];
};

const DEFS = [
  { flag: "--slug", field: "slug", kind: "string" },
  { flag: "--env-file", field: "envFile", kind: "string" },
  { flag: "--admin-url", field: "adminUrl", kind: "string", allowDash: true },
  { flag: "--rename", field: "rename", kind: "repeat" },
] as const satisfies readonly ArgvFlagDef[];

export type WorktreeFlagName = (typeof DEFS)[number]["flag"];

/** Parse worktree-db argv; does not widen the shared gateway FlagBag. */
export function parseWorktreeDbFlags(
  tokens: string[],
  allowed: readonly WorktreeFlagName[],
): Result<WorktreeDbFlags> {
  const emptyBag: WorktreeDbFlags = { rename: [], rest: [] };
  return parseArgv(DEFS, tokens, allowed, emptyBag);
}
