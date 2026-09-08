import { createGitHubForge } from "./github.ts";
import { createGitLabForge } from "./gitlab.ts";
import { resolveForgeKind, type ForgeKind } from "./kind.ts";
import {
  forgeApiError,
  type FetchLike,
  type ForgeClient,
} from "./types.ts";

export { FORGE_KINDS, resolveForgeKind, type ForgeKind } from "./kind.ts";

export type CreateForgeClientOptions = {
  /** Per-forge PAT for GitHub API calls. */
  githubToken?: string;
  /** Per-forge PAT for GitLab API calls. */
  gitlabToken?: string;
  /**
   * @deprecated Prefer githubToken/gitlabToken. When set with `token`, used as
   * fallback for that forge kind only.
   */
  forge?: ForgeKind;
  /**
   * @deprecated Prefer githubToken/gitlabToken. Fallback token when the
   * per-forge token for `forge` is empty.
   */
  token?: string;
  /** Extra host → kind map (see SPROUT_FORGE_HOSTS). */
  hostMap?: Readonly<Record<string, ForgeKind>>;
  fetch?: FetchLike;
};

function tokenForKind(
  kind: ForgeKind,
  options: CreateForgeClientOptions,
): string {
  const perForge =
    kind === "github"
      ? (options.githubToken ?? "")
      : (options.gitlabToken ?? "");
  if (perForge.trim() !== "") return perForge.trim();
  if (options.forge === kind && (options.token ?? "").trim() !== "") {
    return options.token!.trim();
  }
  return "";
}

function missingTokenMessage(kind: ForgeKind): string {
  if (kind === "github") {
    return "Missing GitHub forge token: set SPROUT_GITHUB_TOKEN (or deprecated SPROUT_FORGE=github + SPROUT_FORGE_TOKEN)";
  }
  return "Missing GitLab forge token: set SPROUT_GITLAB_TOKEN (or deprecated SPROUT_FORGE=gitlab + SPROUT_FORGE_TOKEN)";
}

function clientForKind(
  kind: ForgeKind,
  token: string,
  fetchImpl: FetchLike | undefined,
): ForgeClient {
  if (token === "") {
    return {
      async listOpenPrIds() {
        throw forgeApiError(missingTokenMessage(kind), 401);
      },
    };
  }
  if (kind === "github") {
    return createGitHubForge({ token, fetch: fetchImpl });
  }
  if (kind === "gitlab") {
    return createGitLabForge({ token, fetch: fetchImpl });
  }
  throw new Error(`Unsupported forge: ${kind satisfies never}`);
}

/**
 * Forge client that selects GitHub vs GitLab per canonical repo id
 * (URL host inference + optional SPROUT_FORGE_HOSTS map).
 */
export function createForgeClient(
  options: CreateForgeClientOptions,
): ForgeClient {
  const byKind = new Map<ForgeKind, ForgeClient>();

  function getClient(kind: ForgeKind): ForgeClient {
    let client = byKind.get(kind);
    if (!client) {
      client = clientForKind(kind, tokenForKind(kind, options), options.fetch);
      byKind.set(kind, client);
    }
    return client;
  }

  return {
    async listOpenPrIds(canonicalRepoId: string): Promise<number[]> {
      const kind = resolveForgeKind(canonicalRepoId, {
        hostMap: options.hostMap,
      });
      return getClient(kind).listOpenPrIds(canonicalRepoId);
    },
  };
}

export type { ForgeClient } from "./types.ts";
export { forgeApiError, isForgeApiError } from "./types.ts";
