import { forgeApiError } from "./types.ts";

export const FORGE_KINDS = ["github", "gitlab"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** Hosts the GitHub adapter can serve (api.github.com only). */
export const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export const DEFAULT_FORGE_HOST_MAP: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
};

export type ResolveForgeKindOptions = {
  /** Extra or overriding host → kind entries (merged over defaults). */
  hostMap?: Readonly<Record<string, ForgeKind>>;
};

/**
 * Choose forge kind for a canonical repo id from hostname
 * (defaults ∪ optional SPROUT_FORGE_HOSTS map).
 */
export function resolveForgeKind(
  canonicalRepoId: string,
  options: ResolveForgeKindOptions = {},
): ForgeKind {
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
      `Cannot infer forge for host ${host}; set SPROUT_FORGE_HOSTS (custom hosts → gitlab)`,
      400,
    );
  }
  return kind;
}
