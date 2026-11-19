import type { CliDeps } from "../context.ts";
import type { CiIdentity } from "./ci-identity.ts";
import type { Result } from "../result.ts";
import {
  fetchFor,
  githubHeaders,
  readErrorBody,
  stripTrailingSlash,
} from "./forge-http.ts";

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
  const namedRegistry =
    registry.includes(".") || registry.includes(":") || registry === "localhost";
  if (!namedRegistry) return null;
  const repository = name.slice(hostEnd + 1);
  if (!repository) return null;
  return { registry, repository, tag };
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
  wanted: ReadonlySet<string>,
): Promise<Result<{ repositories: Map<string, number>; exhausted: boolean }>> {
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
    if ([...wanted].every((path) => repositories.has(path))) {
      return { ok: true, value: { repositories, exhausted: false } };
    }
    if (data.length < 100) {
      return { ok: true, value: { repositories, exhausted: false } };
    }
  }
  return { ok: true, value: { repositories, exhausted: true } };
}

type DeleteOutcome =
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "unauthorized" }
  | { status: "failed"; detail: string };

async function deleteResource(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  headers: Record<string, string>,
): Promise<DeleteOutcome> {
  let res: Response;
  try {
    res = await doFetch(url, { method: "DELETE", headers });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "failed", detail };
  }
  if (res.ok) return { status: "deleted" };
  if (res.status === 404) return { status: "missing" };
  if (unauthorizedStatus(res.status)) return { status: "unauthorized" };
  return {
    status: "failed",
    detail: `${res.status} ${await readErrorBody(res)}`,
  };
}

function deleteGitlabTag(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GitlabTarget,
  repositoryId: number,
  tag: string,
): Promise<DeleteOutcome> {
  return deleteResource(
    doFetch,
    `${target.api}/projects/${target.project}/registry/repositories/${repositoryId}/tags/${encodeURIComponent(tag)}`,
    gitlabHeaders(target),
  );
}

function unauthorizedWarning(scope: string): string {
  return `registry tag delete is not authorized (missing ${scope} scope); leaving the tags to the forge expiration policy`;
}

type CleanupTally = ImageCleanupReport & { sawUnauthorized: boolean };

function recordOutcome(
  tally: CleanupTally,
  ref: string,
  outcome: DeleteOutcome,
): void {
  switch (outcome.status) {
    case "deleted":
      tally.deleted.push(ref);
      break;
    case "missing":
      tally.warnings.push(`registry tag already absent: ${ref}`);
      break;
    case "unauthorized":
      tally.sawUnauthorized = true;
      break;
    case "failed":
      tally.warnings.push(`registry tag delete failed for ${ref}: ${outcome.detail}`);
      break;
  }
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

  const doFetch = fetchFor(deps);
  const wanted = new Set(parsed.map(({ image }) => image.repository.toLowerCase()));
  const repositories = await listGitlabRepositories(doFetch, target.value, wanted);
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

  const tally: CleanupTally = { deleted: [], warnings: [], sawUnauthorized: false };
  const index = repositories.value;
  const deletions = parsed.map(async ({ ref, image }) => {
    const repositoryId = index.repositories.get(image.repository.toLowerCase());
    if (repositoryId === undefined) return { ref, image, outcome: null };
    const outcome = await deleteGitlabTag(doFetch, target.value, repositoryId, image.tag);
    return { ref, image, outcome };
  });
  for (const { ref, image, outcome } of await Promise.all(deletions)) {
    if (outcome === null) {
      tally.warnings.push(
        index.exhausted
          ? `GitLab registry repository list page cap reached for ${image.repository}; ${image.tag} not resolved`
          : `registry tag already absent: ${ref}`,
      );
      continue;
    }
    recordOutcome(tally, ref, outcome);
  }
  if (tally.sawUnauthorized) tally.warnings.push(unauthorizedWarning("api"));
  return { deleted: tally.deleted, warnings: tally.warnings };
}

type GithubTarget = { api: string; token: string; fallbackToken?: string };

function resolveGithubTarget(env: NodeJS.ProcessEnv): Result<GithubTarget> {
  const deleteToken = env.GHCR_DELETE_TOKEN?.trim();
  const githubToken = env.GITHUB_TOKEN?.trim();
  const ghToken = env.GH_TOKEN?.trim();
  const token = deleteToken || githubToken || ghToken;
  if (!token) {
    return {
      ok: false,
      error:
        "no GitHub token available (set GITHUB_TOKEN with delete:packages or package admin)",
    };
  }
  const fallbackToken =
    deleteToken && deleteToken !== githubToken && deleteToken !== ghToken
      ? githubToken || ghToken
      : undefined;
  return {
    ok: true,
    value: {
      api: stripTrailingSlash(
        env.GITHUB_API_URL?.trim() || "https://api.github.com",
      ),
      token,
      ...(fallbackToken ? { fallbackToken } : {}),
    },
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
      { method: "GET", headers: githubHeaders(target.token) },
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

async function findGithubVersions(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  pkg: GithubPackage,
  wanted: ReadonlySet<string>,
): Promise<
  Result<{ versions: Map<string, GithubVersion>; exhausted: boolean }>
> {
  const versions = new Map<string, GithubVersion>();
  let url = `${target.api}/${pkg.packageBase}/${encodeURIComponent(pkg.packageName)}/versions?per_page=100`;
  for (let page = 0; page < MAX_GHCR_VERSION_PAGES; page++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET", headers: githubHeaders(target.token) });
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
      if (typeof record.id !== "number" || !Array.isArray(tags)) continue;
      const tagList = tags.filter((tag): tag is string => typeof tag === "string");
      for (const tag of tagList) {
        if (!wanted.has(tag) || versions.has(tag)) continue;
        versions.set(tag, { id: record.id, tags: tagList });
      }
    }
    if (versions.size === wanted.size) {
      return { ok: true, value: { versions, exhausted: false } };
    }

    const next = nextLink(res.headers.get("link"));
    if (!next) return { ok: true, value: { versions, exhausted: false } };
    url = next;
  }
  return { ok: true, value: { versions, exhausted: true } };
}

function deleteGithubVersionWithToken(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  token: string,
  pkg: GithubPackage,
  versionId: number,
): Promise<DeleteOutcome> {
  return deleteResource(
    doFetch,
    `${target.api}/${pkg.packageBase}/${encodeURIComponent(pkg.packageName)}/versions/${versionId}`,
    githubHeaders(token),
  );
}

/** The registry login token often lacks delete:packages; the job token can delete. */
async function deleteGithubVersion(
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
  target: GithubTarget,
  pkg: GithubPackage,
  versionId: number,
): Promise<DeleteOutcome> {
  const outcome = await deleteGithubVersionWithToken(
    doFetch,
    target,
    target.token,
    pkg,
    versionId,
  );
  if (outcome.status !== "unauthorized" || !target.fallbackToken) return outcome;
  return deleteGithubVersionWithToken(
    doFetch,
    target,
    target.fallbackToken,
    pkg,
    versionId,
  );
}

type GithubGroup = {
  image: ParsedImageRef;
  tags: Set<string>;
  refs: Array<{ ref: string; tag: string }>;
};

async function cleanupGithub(
  deps: CliDeps,
  refs: string[],
): Promise<ImageCleanupReport> {
  const target = resolveGithubTarget(deps.env);
  if (!target.ok) {
    return { deleted: [], warnings: [`registry tag cleanup skipped: ${target.error}`] };
  }

  const tally: CleanupTally = { deleted: [], warnings: [], sawUnauthorized: false };
  const groups = new Map<string, GithubGroup>();
  for (const ref of refs) {
    const image = parseImageRef(ref);
    if (!image) {
      tally.warnings.push(
        `registry tag cleanup skipped for ${ref}: unsupported image reference`,
      );
      continue;
    }
    if (image.registry.toLowerCase() !== "ghcr.io") {
      tally.warnings.push(
        `registry tag cleanup skipped for ${ref}: only ghcr.io is supported on GitHub`,
      );
      continue;
    }
    const group = groups.get(image.repository);
    if (group) {
      group.tags.add(image.tag);
      group.refs.push({ ref, tag: image.tag });
    } else {
      groups.set(image.repository, {
        image,
        tags: new Set([image.tag]),
        refs: [{ ref, tag: image.tag }],
      });
    }
  }

  const doFetch = fetchFor(deps);
  const packages = await Promise.all(
    [...groups].map(async ([repository, group]) => ({
      repository,
      group,
      pkg: await resolveGithubPackage(doFetch, target.value, group.image),
    })),
  );

  for (const { repository, group, pkg } of packages) {
    const skip = (error: string) => {
      if (unauthorizedDetail(error)) {
        tally.sawUnauthorized = true;
        return;
      }
      for (const { ref } of group.refs) {
        tally.warnings.push(`registry tag cleanup skipped for ${ref}: ${error}`);
      }
    };
    if (!pkg.ok) {
      skip(pkg.error);
      continue;
    }
    const versions = await findGithubVersions(
      doFetch,
      target.value,
      pkg.value,
      group.tags,
    );
    if (!versions.ok) {
      skip(versions.error);
      continue;
    }
    for (const { ref, tag } of group.refs) {
      const version = versions.value.versions.get(tag);
      if (!version) {
        tally.warnings.push(
          versions.value.exhausted
            ? `GHCR version list page cap reached for ${repository}; ${tag} not resolved`
            : `registry tag already absent: ${ref}`,
        );
        continue;
      }
      const extraTags = version.tags.filter((item) => !group.tags.has(item));
      if (extraTags.length > 0) {
        tally.warnings.push(
          `registry tag delete skipped for ${ref}: GHCR version ${version.id} also carries ${extraTags.join(", ")}`,
        );
        continue;
      }
      const outcome = await deleteGithubVersion(
        doFetch,
        target.value,
        pkg.value,
        version.id,
      );
      recordOutcome(tally, ref, outcome);
    }
  }
  if (tally.sawUnauthorized) {
    tally.warnings.push(unauthorizedWarning("delete:packages"));
  }
  return { deleted: tally.deleted, warnings: tally.warnings };
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
