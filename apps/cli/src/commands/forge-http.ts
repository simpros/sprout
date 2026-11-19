import type { CliDeps } from "../context.ts";

export function fetchFor(
  deps: CliDeps,
): (url: string, init?: RequestInit) => Promise<Response> {
  return deps.fetchFn ?? globalThis.fetch;
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? text.slice(0, 300) : res.statusText || "unknown error";
  } catch {
    return res.statusText || "unknown error";
  }
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
