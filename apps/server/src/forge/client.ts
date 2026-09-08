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
  /** Extra host → kind map (see SPROUT_FORGE_HOSTS). */
  hostMap?: Readonly<Record<string, ForgeKind>>;
  fetch?: FetchLike;
};

function tokenForKind(
  kind: ForgeKind,
  options: CreateForgeClientOptions,
): string {
  const raw =
    kind === "github"
      ? (options.githubToken ?? "")
      : (options.gitlabToken ?? "");
  return raw.trim();
}

function missingTokenMessage(kind: ForgeKind): string {
  if (kind === "github") {
    return "Missing GitHub forge token: set SPROUT_GITHUB_TOKEN";
  }
  return "Missing GitLab forge token: set SPROUT_GITLAB_TOKEN";
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
