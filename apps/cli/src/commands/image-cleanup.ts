import type { CliDeps } from "../context.ts";
import type { CiIdentity } from "./ci-identity.ts";
import type { Result } from "../result.ts";

export type ParsedImageRef = {
  registry: string;
  repository: string;
  tag: string;
};

export type ImageCleanupReport = {
  deleted: string[];
  warnings: string[];
};

const MAX_GITLAB_REPOSITORIES_PAGES = 10;
const MAX_GHCR_VERSION_PAGES = 100;

function fetchFor(deps: CliDeps): (url: string, init?: RequestInit) => Promise<Response> {
  return deps.fetchFn ?? globalThis.fetch;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function parseImageRef(ref: string): ParsedImageRef | null {
  const trimmed = ref.trim();
  const slash = trimmed.lastIndexOf("/");
  const colon = trimmed.lastIndexOf(":");
  if (slash <= 0 || colon <= slash || colon === trimmed.length - 1) return null;

  const name = trimmed.slice(0, colon);
  const tag = trimmed.slice(colon + 1);
  const hostEnd = name.indexOf("/");
  if (hostEnd <= 0) return null;
  const registry = name.slice(0, hostEnd);
  if (
    !registry.includes(".") &&
    !registry.includes(":") &&
    registry !== "localhost"
  ) {
    return null;
  }
  const repository = name.slice(hostEnd + 1);
  if (!repository || tag.includes("/")) return null;
  return { registry, repository, tag };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? text.slice(0, 300) : res.statusText || "unknown error";
  } catch {
    return res.statusText || "unknown error";
  }
}

function unauthorizedStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function unauthorizedDetail(detail: string): boolean {
  return /\b(401|403)\b/.test(detail);
}

type GitlabTarget = {
  api: string;
  project: string;
  token: string;
  tokenHeader: "JOB-TOKEN" | "PRIVATE-TOKEN";
};

function resolveGitlabTarget(env: NodeJS.ProcessEnv): Result<GitlabTarget> {
  const pat = env.GITLAB_TOKEN?.trim();
  const jobToken = env.CI_JOB_TOKEN?.trim();
  const token = pat || jobToken;
  if (!token) {
    return {
      ok: false,
      error:
        "no GitLab token available (set GITLAB_TOKEN with api scope, or run in a CI job with CI_JOB_TOKEN)",
    };
  }

  const server = env.CI_SERVER_URL?.trim();
  const api = stripTrailingSlash(
    env.CI_API_V4_URL?.trim() ||
      (server ? `${stripTrailingSlash(server)}/api/v4` : "https://gitlab.com/api/v4"),
  );

  const projectId = env.CI_PROJECT_ID?.trim();
  const projectPath = env.CI_PROJECT_PATH?.trim();
  if (!projectId && !projectPath) {
    return {
      ok: false,
      error:
        "cannot resolve GitLab project (set CI_PROJECT_ID or CI_PROJECT_PATH)",
    };
  }

  return {
    ok: true,
    value: {
      api,
      project: projectId || encodeURIComponent(projectPath!),
      token,
      tokenHeader: pat ? "PRIVATE-TOKEN" : "JOB-TOKEN",
    },
  };
}

function gitlabHeaders(target: GitlabTarget): Record<string, string> {
  return { [target.tokenHeader]: target.token };
}

async function listGitlabRepositories(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GitlabTarget,
): Promise<Result<Map<string, number>>> {
  const repositories = new Map<string, number>();
  for (let page = 1; page <= MAX_GITLAB_REPOSITORIES_PAGES; page++) {
    let res: Response;
    try {
      res = await doFetch(
        `${target.api}/projects/${target.project}/registry/repositories?per_page=100&page=${page}`,
        { method: "GET", headers: gitlabHeaders(target) },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `registry repository list failed: ${detail}` };
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      if (unauthorizedStatus(res.status)) {
        return {
          ok: false,
          error: `registry repository list unauthorized: ${res.status} ${body}`,
        };
      }
      return {
        ok: false,
        error: `registry repository list failed: ${res.status} ${body}`,
      };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: "registry repository list returned invalid JSON" };
    }
    if (!Array.isArray(data)) {
      return { ok: false, error: "registry repository list returned invalid JSON" };
    }

    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; path?: unknown };
      if (typeof record.id === "number" && typeof record.path === "string") {
        repositories.set(record.path.toLowerCase(), record.id);
      }
    }
    if (data.length < 100) break;
  }
  return { ok: true, value: repositories };
}

type DeleteOutcome =
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "unauthorized" }
  | { status: "failed"; detail: string };

async function deleteGitlabTag(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GitlabTarget,
  repositoryId: number,
  tag: string,
): Promise<DeleteOutcome> {
  let res: Response;
  try {
    res = await doFetch(
      `${target.api}/projects/${target.project}/registry/repositories/${repositoryId}/tags/${encodeURIComponent(tag)}`,
      { method: "DELETE", headers: gitlabHeaders(target) },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "failed", detail };
  }
  if (res.ok || res.status === 202) return { status: "deleted" };
  if (res.status === 404) return { status: "missing" };
  if (unauthorizedStatus(res.status)) return { status: "unauthorized" };
  return {
    status: "failed",
    detail: `${res.status} ${await readErrorBody(res)}`,
  };
}

function unauthorizedWarning(scope: string): string {
  return `registry tag delete is not authorized (missing ${scope} scope); leaving the tags to the forge expiration policy`;
}

async function cleanupGitlab(
  deps: CliDeps,
  refs: string[],
): Promise<ImageCleanupReport> {
  const target = resolveGitlabTarget(deps.env);
  if (!target.ok) {
    return { deleted: [], warnings: [`registry tag cleanup skipped: ${target.error}`] };
  }

  const parsed = refs.flatMap((ref) => {
    const image = parseImageRef(ref);
    return image ? [{ ref, image }] : [];
  });
  if (parsed.length === 0) return { deleted: [], warnings: [] };

  const repositories = await listGitlabRepositories(fetchFor(deps), target.value);
  if (!repositories.ok) {
    const unauthorized = repositories.error.includes("unauthorized");
    return {
      deleted: [],
      warnings: [
        unauthorized
          ? unauthorizedWarning("api")
          : `${repositories.error}`,
      ],
    };
  }

  const deleted: string[] = [];
  const warnings: string[] = [];
  let sawUnauthorized = false;
  for (const { ref, image } of parsed) {
    const repositoryId = repositories.value.get(image.repository.toLowerCase());
    if (repositoryId === undefined) {
      warnings.push(`registry tag already absent: ${ref}`);
      continue;
    }
    const outcome = await deleteGitlabTag(
      fetchFor(deps),
      target.value,
      repositoryId,
      image.tag,
    );
    switch (outcome.status) {
      case "deleted":
        deleted.push(ref);
        break;
      case "missing":
        warnings.push(`registry tag already absent: ${ref}`);
        break;
      case "unauthorized":
        sawUnauthorized = true;
        break;
      case "failed":
        warnings.push(`registry tag delete failed for ${ref}: ${outcome.detail}`);
        break;
    }
  }
  if (sawUnauthorized) warnings.push(unauthorizedWarning("api"));
  return { deleted, warnings };
}

type GithubTarget = { api: string; token: string };

function resolveGithubTarget(env: NodeJS.ProcessEnv): Result<GithubTarget> {
  const token =
    env.GHCR_DELETE_TOKEN?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      error:
        "no GitHub token available (set GITHUB_TOKEN with delete:packages or package admin)",
    };
  }
  return {
    ok: true,
    value: {
      api: stripTrailingSlash(
        env.GITHUB_API_URL?.trim() || "https://api.github.com",
      ),
      token,
    },
  };
}

function githubHeaders(target: GithubTarget): Record<string, string> {
  return {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

type GithubPackage = { packageBase: string; packageName: string };

async function resolveGithubPackage(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  image: ParsedImageRef,
): Promise<Result<GithubPackage>> {
  const parts = image.repository.split("/");
  const owner = parts[0];
  const packageName = parts.slice(1).join("/");
  if (!owner || !packageName) {
    return {
      ok: false,
      error: `cannot derive GHCR package from ${image.registry}/${image.repository}`,
    };
  }

  let res: Response;
  try {
    res = await doFetch(
      `${target.api}/users/${encodeURIComponent(owner)}`,
      { method: "GET", headers: githubHeaders(target) },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GHCR owner lookup failed: ${detail}` };
  }
  if (!res.ok) {
    const body = await readErrorBody(res);
    return {
      ok: false,
      error: `GHCR owner lookup failed: ${res.status} ${body}`,
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "GHCR owner lookup returned invalid JSON" };
  }
  const type =
    typeof data === "object" && data !== null
      ? (data as { type?: unknown }).type
      : undefined;
  const ownerBase = type === "Organization" ? "orgs" : "users";
  return {
    ok: true,
    value: {
      packageBase: `${ownerBase}/${encodeURIComponent(owner)}/packages/container`,
      packageName,
    },
  };
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel\s*=\s*"?next"?/.test(part)) continue;
    const match = /<([^>]+)>/.exec(part);
    if (match) return match[1] ?? null;
  }
  return null;
}

type GithubVersion = { id: number; tags: string[] };

async function findGithubVersion(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  pkg: GithubPackage,
  tag: string,
): Promise<Result<GithubVersion | null>> {
  let url = `${target.api}/${pkg.packageBase}/${encodeURIComponent(pkg.packageName)}/versions?per_page=100`;
  for (let page = 0; page < MAX_GHCR_VERSION_PAGES; page++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers: githubHeaders(target) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `GHCR version list failed: ${detail}` };
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      return {
        ok: false,
        error: `GHCR version list failed: ${res.status} ${body}`,
      };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: "GHCR version list returned invalid JSON" };
    }
    if (!Array.isArray(data)) {
      return { ok: false, error: "GHCR version list returned invalid JSON" };
    }

    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as {
        id?: unknown;
        metadata?: { container?: { tags?: unknown } };
      };
      const tags = record.metadata?.container?.tags;
      if (
        typeof record.id === "number" &&
        Array.isArray(tags) &&
        tags.includes(tag)
      ) {
        return {
          ok: true,
          value: {
            id: record.id,
            tags: tags.filter((item): item is string => typeof item === "string"),
          },
        };
      }
    }

    const next = nextLink(res.headers.get("link"));
    if (!next) return { ok: true, value: null };
    url = next;
  }
  return { ok: true, value: null };
}

async function deleteGithubVersion(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  pkg: GithubPackage,
  versionId: number,
): Promise<DeleteOutcome> {
  let res: Response;
  try {
    res = await doFetch(
      `${target.api}/${pkg.packageBase}/${encodeURIComponent(pkg.packageName)}/versions/${versionId}`,
      { method: "DELETE", headers: githubHeaders(target) },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "failed", detail };
  }
  if (res.ok || res.status === 204) return { status: "deleted" };
  if (res.status === 404) return { status: "missing" };
  if (unauthorizedStatus(res.status)) return { status: "unauthorized" };
  return {
    status: "failed",
    detail: `${res.status} ${await readErrorBody(res)}`,
  };
}

async function cleanupGithub(
  deps: CliDeps,
  refs: string[],
): Promise<ImageCleanupReport> {
  const target = resolveGithubTarget(deps.env);
  if (!target.ok) {
    return { deleted: [], warnings: [`registry tag cleanup skipped: ${target.error}`] };
  }

  type GithubEntry =
    | { ref: string; warning: string }
    | { ref: string; image: ParsedImageRef };
  const parsed: GithubEntry[] = refs.map((ref) => {
    const image = parseImageRef(ref);
    if (!image) {
      return {
        ref,
        warning: `registry tag cleanup skipped for ${ref}: unsupported image reference`,
      };
    }
    if (image.registry.toLowerCase() !== "ghcr.io") {
      return {
        ref,
        warning: `registry tag cleanup skipped for ${ref}: only ghcr.io is supported on GitHub`,
      };
    }
    return { ref, image };
  });

  const targetTags = new Map<string, Set<string>>();
  for (const entry of parsed) {
    if (!("image" in entry)) continue;
    const tags = targetTags.get(entry.image.repository) ?? new Set<string>();
    tags.add(entry.image.tag);
    targetTags.set(entry.image.repository, tags);
  }

  const deleted: string[] = [];
  const warnings: string[] = [];
  let sawUnauthorized = false;
  for (const entry of parsed) {
    if ("warning" in entry) {
      warnings.push(entry.warning);
      continue;
    }
    const pkg = await resolveGithubPackage(
      fetchFor(deps),
      target.value,
      entry.image,
    );
    if (!pkg.ok) {
      if (unauthorizedDetail(pkg.error)) {
        sawUnauthorized = true;
      } else {
        warnings.push(
          `registry tag cleanup skipped for ${entry.ref}: ${pkg.error}`,
        );
      }
      continue;
    }
    const version = await findGithubVersion(
      fetchFor(deps),
      target.value,
      pkg.value,
      entry.image.tag,
    );
    if (!version.ok) {
      if (unauthorizedDetail(version.error)) {
        sawUnauthorized = true;
      } else {
        warnings.push(
          `registry tag cleanup skipped for ${entry.ref}: ${version.error}`,
        );
      }
      continue;
    }
    if (version.value === null) {
      warnings.push(`registry tag already absent: ${entry.ref}`);
      continue;
    }
    const wanted = targetTags.get(entry.image.repository) ?? new Set<string>();
    const extraTags = version.value.tags.filter((tag) => !wanted.has(tag));
    if (extraTags.length > 0) {
      warnings.push(
        `registry tag delete skipped for ${entry.ref}: GHCR version ${version.value.id} also carries ${extraTags.join(", ")}`,
      );
      continue;
    }
    const outcome = await deleteGithubVersion(
      fetchFor(deps),
      target.value,
      pkg.value,
      version.value.id,
    );
    switch (outcome.status) {
      case "deleted":
        deleted.push(entry.ref);
        break;
      case "missing":
        warnings.push(`registry tag already absent: ${entry.ref}`);
        break;
      case "unauthorized":
        sawUnauthorized = true;
        break;
      case "failed":
        warnings.push(
          `registry tag delete failed for ${entry.ref}: ${outcome.detail}`,
        );
        break;
    }
  }
  if (sawUnauthorized) warnings.push(unauthorizedWarning("delete:packages"));
  return { deleted, warnings };
}

export async function cleanupPushedImageRefs(
  deps: CliDeps,
  identity: Pick<CiIdentity, "forge">,
  refs: string[],
): Promise<ImageCleanupReport> {
  if (refs.length === 0) return { deleted: [], warnings: [] };
  if (identity.forge === "gitlab") return cleanupGitlab(deps, refs);
  return cleanupGithub(deps, refs);
}
