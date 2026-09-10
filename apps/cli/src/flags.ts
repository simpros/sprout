import type { Result } from "./result.ts";

type FlagBag = {
  image?: string;
  seedImage?: string;
  seedEnv: string[];
  seedArg: string[];
  appEnv: string[];
  appEnvFile: string[];
  yes: boolean;
  repo?: string;
  slug?: string;
  scope?: string;
  rest: string[];
};

type FlagKind = "boolean" | "string" | "repeat";

export type ArgvFlagDef<TFlag extends string = string> = {
  flag: TFlag;
  field: string;
  kind: FlagKind;
  allowDash?: boolean;
};

/**
 * Bag-agnostic argv walker. Callers keep distinct typed bags; this owns the
 * rest/allow-set/missing-value/string-vs-repeat loop once.
 */
export function parseArgv<TFlag extends string, TBag extends { rest: string[] }>(
  defs: readonly ArgvFlagDef<TFlag>[],
  tokens: string[],
  allowed: readonly TFlag[],
  emptyBag: TBag,
): Result<TBag> {
  const byName = new Map(defs.map((d) => [d.flag, d] as const));
  const allow = new Set<TFlag>(allowed);
  const out = emptyBag;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) {
      out.rest.push(token);
      continue;
    }

    const def = byName.get(token as TFlag);
    if (!def || !allow.has(def.flag)) {
      return { ok: false, error: `unknown flag: ${token}` };
    }

    if (def.kind === "boolean") {
      (out as Record<string, unknown>)[def.field] = true;
      continue;
    }

    const value = tokens[++i];
    if (value === undefined || (!def.allowDash && value.startsWith("-"))) {
      return { ok: false, error: `missing value for ${def.flag}` };
    }

    if (def.kind === "repeat") {
      const list = (out as Record<string, unknown>)[def.field];
      if (!Array.isArray(list)) {
        return { ok: false, error: `internal: ${def.flag} is not a list field` };
      }
      list.push(value);
    } else {
      (out as Record<string, unknown>)[def.field] = value;
    }
  }

  return { ok: true, value: out };
}

const FLAG_DEFS = [
  { flag: "-i", field: "image", kind: "string" },
  { flag: "-s", field: "seedImage", kind: "string" },
  { flag: "--seed-env", field: "seedEnv", kind: "repeat", allowDash: true },
  { flag: "--seed-arg", field: "seedArg", kind: "repeat", allowDash: true },
  { flag: "--app-env", field: "appEnv", kind: "repeat", allowDash: true },
  { flag: "--app-env-file", field: "appEnvFile", kind: "repeat" },
  { flag: "--yes", field: "yes", kind: "boolean" },
  { flag: "--repo", field: "repo", kind: "string" },
  { flag: "--slug", field: "slug", kind: "string" },
  { flag: "--scope", field: "scope", kind: "string" },
] as const satisfies readonly ArgvFlagDef[];

type FlagName = (typeof FLAG_DEFS)[number]["flag"];

/** Parse argv tokens, accepting only the listed flags. */
export function parseFlags(
  tokens: string[],
  allowed: readonly FlagName[],
): Result<FlagBag> {
  const emptyBag: FlagBag = {
    seedEnv: [],
    seedArg: [],
    appEnv: [],
    appEnvFile: [],
    yes: false,
    rest: [],
  };
  return parseArgv(FLAG_DEFS, tokens, allowed, emptyBag);
}
