import { forgeApiError } from "./types.ts";

export const FORGE_KINDS = ["github", "gitlab"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** Hosts the GitHub adapter can serve (api.github.com only). */
export const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Built-in GitLab hosts (self-managed hosts go in SPROUT_FORGE_HOSTS). */
export const GITLAB_DEFAULT_HOSTS = new Set(["gitlab.com", "www.gitlab.com"]);

export type ResolveForgeKindOptions = {
  /** Extra self-managed GitLab hosts (from SPROUT_FORGE_HOSTS). */
  extraGitlabHosts?: ReadonlySet<string>;
};

/**
 * Choose forge kind for a canonical repo id from hostname
 * (built-in hosts ∪ optional SPROUT_FORGE_HOSTS extras).
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
  if (GITHUB_HOSTS.has(host)) return "github";
  const extras = options.extraGitlabHosts ?? new Set<string>();
  if (GITLAB_DEFAULT_HOSTS.has(host) || extras.has(host)) return "gitlab";
  throw forgeApiError(
    `Cannot infer forge for host ${host}; set SPROUT_FORGE_HOSTS (custom hosts → gitlab)`,
    400,
  );
}
