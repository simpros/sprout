import { finiteIdsFromArray } from "./parse.ts";
import { forgeApiError, type FetchLike, type ForgeClient } from "./types.ts";

export type GitLabForgeOptions = {
  token: string;
  fetch?: FetchLike;
  /** Override API root; default derived from canonical repo host. */
  apiBase?: string;
};

const PER_PAGE = 100;

/** Parse https://gitlab.example/group/project → { host, path }. */
export function parseGitLabProject(
  canonicalRepoId: string,
): { host: string; path: string } {
  let url: URL;
  try {
    url = new URL(canonicalRepoId);
  } catch {
    throw forgeApiError(
      `Invalid GitLab canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw forgeApiError(
      `Invalid GitLab canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path || !path.includes("/")) {
    throw forgeApiError(
      `Invalid GitLab canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  return { host: url.hostname, path };
}

/** @deprecated Prefer parseGitLabProject; kept for callers expecting a path string. */
export function parseGitLabProjectPath(canonicalRepoId: string): string {
  return parseGitLabProject(canonicalRepoId).path;
}

export function createGitLabForge(options: GitLabForgeOptions): ForgeClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async listOpenPrIds(canonicalRepoId: string): Promise<number[]> {
      const { host, path } = parseGitLabProject(canonicalRepoId);
      const apiBase =
        options.apiBase ?? `${new URL(canonicalRepoId).protocol}//${host}/api/v4`;
      const encoded = encodeURIComponent(path);
      const ids: number[] = [];
      let page = 1;

      while (true) {
        const url = `${apiBase}/projects/${encoded}/merge_requests?state=opened&per_page=${PER_PAGE}&page=${page}`;
        const res = await fetchImpl(url, {
          headers: {
            "private-token": options.token,
          },
        });
        if (!res.ok) {
          throw forgeApiError(
            `GitLab open-MR list failed: ${res.status}`,
            res.status,
          );
        }
        const pageIds = finiteIdsFromArray(await res.json(), "iid");
        ids.push(...pageIds);
        if (pageIds.length < PER_PAGE) break;
        page += 1;
      }

      return ids;
    },
  };
}
