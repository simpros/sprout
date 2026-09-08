import { forgeApiError } from "./types.ts";

export const FORGE_KINDS = ["github", "gitlab"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export const DEFAULT_FORGE_HOST_MAP: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
};

export type ResolveForgeKindOptions = {
  /** Stored per-repo override (token mint / repo register). Wins over host map. */
  explicit?: ForgeKind;
  /** Extra or overriding host → kind entries (merged over defaults). */
  hostMap?: Readonly<Record<string, ForgeKind>>;
};

/**
 * Choose forge kind for a canonical repo id.
 * Explicit field wins; otherwise hostname is looked up in hostMap ∪ defaults.
 */
export function resolveForgeKind(
  canonicalRepoId: string,
  options: ResolveForgeKindOptions = {},
): ForgeKind {
  if (options.explicit) return options.explicit;

  let url: URL;
  try {
    url = new URL(canonicalRepoId);
  } catch {
    throw forgeApiError(
      `Invalid canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }

  const host = url.hostname.toLowerCase();
  const merged: Record<string, ForgeKind> = {
    ...DEFAULT_FORGE_HOST_MAP,
    ...options.hostMap,
  };
  const kind = merged[host];
  if (!kind) {
    throw forgeApiError(
      `Cannot infer forge for host ${host}; set repos.forge or SPROUT_FORGE_HOSTS`,
      400,
    );
  }
  return kind;
}
