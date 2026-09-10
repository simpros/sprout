import type { Result } from "./result.ts";

export type FlagBag = {
  image?: string;
  seedImage?: string;
  seedEnv: string[];
  seedArg: string[];
  appEnv: string[];
  yes: boolean;
  repo?: string;
  slug?: string;
  scope?: string;
  rest: string[];
};

const FLAG_DEFS = [
  { flag: "-i", field: "image", kind: "string" },
  { flag: "-s", field: "seedImage", kind: "string" },
  { flag: "--seed-env", field: "seedEnv", kind: "repeat", allowDash: true },
  { flag: "--seed-arg", field: "seedArg", kind: "repeat", allowDash: true },
  { flag: "--app-env", field: "appEnv", kind: "repeat", allowDash: true },
  { flag: "--yes", field: "yes", kind: "boolean" },
  { flag: "--repo", field: "repo", kind: "string" },
  { flag: "--slug", field: "slug", kind: "string" },
  { flag: "--scope", field: "scope", kind: "string" },
] as const;

export type FlagName = (typeof FLAG_DEFS)[number]["flag"];

const FLAG_BY_NAME = new Map(
  FLAG_DEFS.map((d) => [d.flag, d] as const),
);

/** Parse argv tokens, accepting only the listed flags. */
export function parseFlags(
  tokens: string[],
  allowed: readonly FlagName[],
): Result<FlagBag> {
  const allow = new Set<FlagName>(allowed);
  const out: FlagBag = {
    seedEnv: [],
    seedArg: [],
    appEnv: [],
    yes: false,
    rest: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) {
      out.rest.push(token);
      continue;
    }

    const def = FLAG_BY_NAME.get(token as FlagName);
    if (!def || !allow.has(def.flag)) {
      return { ok: false, error: `unknown flag: ${token}` };
    }

    if (def.kind === "boolean") {
      out[def.field] = true;
      continue;
    }

    const value = tokens[++i];
    const allowDash = "allowDash" in def && def.allowDash;
    if (value === undefined || (!allowDash && value.startsWith("-"))) {
      return { ok: false, error: `missing value for ${def.flag}` };
    }

    if (def.kind === "repeat") {
      out[def.field].push(value);
    } else {
      out[def.field] = value;
    }
  }

  return { ok: true, value: out };
}
