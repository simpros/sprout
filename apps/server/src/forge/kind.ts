import { forgeApiError } from "./types.ts";

export type ForgeKind = "github" | "gitlab";

export const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export const GITLAB_DEFAULT_HOSTS = new Set(["gitlab.com", "www.gitlab.com"]);

export type ResolveForgeKindOptions = {
  extraGitlabHosts?: ReadonlySet<string>;
};

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
