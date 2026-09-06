import type { Result } from "./result.ts";

export type FlagName =
  | "-i"
  | "-s"
  | "--seed-env"
  | "--seed-arg"
  | "--yes"
  | "--repo"
  | "--slug"
  | "--scope";

export type FlagBag = {
  image?: string;
  seedImage?: string;
  seedEnv: string[];
  seedArg: string[];
  yes: boolean;
  repo?: string;
  slug?: string;
  scope?: string;
  rest: string[];
};

/** Parse argv tokens, accepting only the listed flags. */
export function parseFlags(
  tokens: string[],
  allowed: readonly FlagName[],
): Result<FlagBag> {
  const allow = new Set<FlagName>(allowed);
  const out: FlagBag = {
    seedEnv: [],
    seedArg: [],
    yes: false,
    rest: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = (opts?: { allowDash?: boolean }) => {
      const value = tokens[++i];
      if (value === undefined) return null;
      if (!opts?.allowDash && value.startsWith("-")) return null;
      return value;
    };

    const requireAllowed = (flag: FlagName): string | null => {
      if (!allow.has(flag)) return `unknown flag: ${flag}`;
      return null;
    };

    switch (token) {
      case "-i": {
        const denied = requireAllowed("-i");
        if (denied) return { ok: false, error: denied };
        const value = next();
        if (!value) return { ok: false, error: "missing value for -i" };
        out.image = value;
        break;
      }
      case "-s": {
        const denied = requireAllowed("-s");
        if (denied) return { ok: false, error: denied };
        const value = next();
        if (!value) return { ok: false, error: "missing value for -s" };
        out.seedImage = value;
        break;
      }
      case "--seed-env": {
        const denied = requireAllowed("--seed-env");
        if (denied) return { ok: false, error: denied };
        const value = next({ allowDash: true });
        if (!value) return { ok: false, error: "missing value for --seed-env" };
        out.seedEnv.push(value);
        break;
      }
      case "--seed-arg": {
        const denied = requireAllowed("--seed-arg");
        if (denied) return { ok: false, error: denied };
        // Seed args are often flags themselves (e.g. `--reset`).
        const value = next({ allowDash: true });
        if (!value) return { ok: false, error: "missing value for --seed-arg" };
        out.seedArg.push(value);
        break;
      }
      case "--yes": {
        const denied = requireAllowed("--yes");
        if (denied) return { ok: false, error: denied };
        out.yes = true;
        break;
      }
      case "--repo": {
        const denied = requireAllowed("--repo");
        if (denied) return { ok: false, error: denied };
        const value = next();
        if (!value) return { ok: false, error: "missing value for --repo" };
        out.repo = value;
        break;
      }
      case "--slug": {
        const denied = requireAllowed("--slug");
        if (denied) return { ok: false, error: denied };
        const value = next();
        if (!value) return { ok: false, error: "missing value for --slug" };
        out.slug = value;
        break;
      }
      case "--scope": {
        const denied = requireAllowed("--scope");
        if (denied) return { ok: false, error: denied };
        const value = next();
        if (!value) return { ok: false, error: "missing value for --scope" };
        out.scope = value;
        break;
      }
      default:
        if (token.startsWith("-")) {
          return { ok: false, error: `unknown flag: ${token}` };
        }
        out.rest.push(token);
    }
  }

  return { ok: true, value: out };
}
