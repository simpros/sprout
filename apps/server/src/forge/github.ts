import { finiteIdsFromArray } from "./parse.ts";
import { GITHUB_HOSTS } from "./kind.ts";
import { forgeApiError, type FetchLike, type ForgeClient } from "./types.ts";

export type GitHubForgeOptions = {
  token: string;
  fetch?: FetchLike;
  apiBase?: string;
};

const PER_PAGE = 100;

/** Parse https://github.com/owner/repo → { owner, repo }. */
function parseGitHubRepo(canonicalRepoId: string): {
  owner: string;
  repo: string;
} {
  let url: URL;
  try {
    url = new URL(canonicalRepoId);
  } catch {
    throw forgeApiError(
      `Invalid GitHub canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    throw forgeApiError(`Not a github.com repo id: ${canonicalRepoId}`, 400);
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw forgeApiError(
      `Invalid GitHub canonical repo id: ${canonicalRepoId}`,
      400,
    );
  }
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
}

export function createGitHubForge(options: GitHubForgeOptions): ForgeClient {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";

  return {
    async listOpenPrIds(canonicalRepoId: string): Promise<number[]> {
      const { owner, repo } = parseGitHubRepo(canonicalRepoId);
      let url: string | null =
        `${apiBase}/repos/${owner}/${repo}/pulls?state=open&per_page=${PER_PAGE}`;
      const ids: number[] = [];

      while (url) {
        const res = await fetchImpl(url, {
          headers: {
            authorization: `Bearer ${options.token}`,
            accept: "application/vnd.github+json",
          },
        });
        if (!res.ok) {
          throw forgeApiError(
            `GitHub open-PR list failed: ${res.status}`,
            res.status,
          );
        }
        ids.push(...finiteIdsFromArray(await res.json(), "number"));
        url = nextLink(res.headers.get("link"));
      }

      return ids;
    },
  };
}
