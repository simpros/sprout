import { createGitHubForge } from "./github.ts";
import { createGitLabForge } from "./gitlab.ts";
import { forgeApiError, type FetchLike, type ForgeClient } from "./types.ts";

export const FORGE_KINDS = ["github", "gitlab"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export type CreateForgeClientOptions = {
  forge: ForgeKind;
  token: string;
  fetch?: FetchLike;
};

export function createForgeClient(
  options: CreateForgeClientOptions,
): ForgeClient {
  // Token may be empty at boot (compose/e2e); degrade via the same ForgeApiError
  // channel as live forge failures so sweeps soft-fail into forgeRepoFailures.
  if (options.token.trim() === "") {
    return {
      async listOpenPrIds() {
        throw forgeApiError(
          "Missing SPROUT_FORGE_TOKEN: required for forge API calls",
          401,
        );
      },
    };
  }

  if (options.forge === "github") {
    return createGitHubForge({
      token: options.token,
      fetch: options.fetch,
    });
  }
  if (options.forge === "gitlab") {
    return createGitLabForge({
      token: options.token,
      fetch: options.fetch,
    });
  }
  throw new Error(`Unsupported forge: ${options.forge satisfies never}`);
}

export type { ForgeClient } from "./types.ts";
export { forgeApiError, isForgeApiError } from "./types.ts";
