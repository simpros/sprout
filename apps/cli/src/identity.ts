import type { Result } from "./result.ts";

export type Forge = "gitlab" | "github";

export function normalizeGitRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (ssh) {
    const host = ssh[1];
    const path = ssh[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  const sshUrl = /^ssh:\/\/git@([^/]+)\/(.+)$/.exec(trimmed);
  if (sshUrl) {
    const host = sshUrl[1];
    const path = sshUrl[2].replace(/\.git$/, "");
    return `https://${host}/${path}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\.git$/, "");
  }

  return null;
}

function positiveInt(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function stripGitSuffix(url: string): string {
  return url.replace(/\.git$/, "");
}

export function githubRepoUrl(slug: string): string {
  return `https://github.com/${slug}`;
}

/** Forge-scoped repo URL from CI env (no git-remote fallback). */
export function resolveRepoForForge(
  forge: Forge,
  env: NodeJS.ProcessEnv,
): Result<string> {
  if (forge === "gitlab") {
    const gitlab = env.CI_PROJECT_URL?.trim();
    if (gitlab) {
      return { ok: true, value: stripGitSuffix(gitlab) };
    }
    return {
      ok: false,
      error: "cannot derive canonical repo id (set CI_PROJECT_URL)",
    };
  }

  const github = env.GITHUB_REPOSITORY?.trim();
  if (github) {
    return { ok: true, value: githubRepoUrl(github) };
  }
  return {
    ok: false,
    error: "cannot derive canonical repo id (set GITHUB_REPOSITORY)",
  };
}

export function resolveCanonicalRepoId(input: {
  env: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
}): Result<string> {
  const githubRepo = input.env.GITHUB_REPOSITORY?.trim();
  if (githubRepo) {
    return { ok: true, value: githubRepoUrl(githubRepo) };
  }

  const gitlabUrl = input.env.CI_PROJECT_URL?.trim();
  if (gitlabUrl) {
    return { ok: true, value: stripGitSuffix(gitlabUrl) };
  }

  if (input.gitRemoteUrl) {
    const normalized = normalizeGitRemoteUrl(input.gitRemoteUrl);
    if (normalized) return { ok: true, value: normalized };
  }

  return {
    ok: false,
    error:
      "cannot derive canonical repo id (set GITHUB_REPOSITORY, CI_PROJECT_URL, or git remote)",
  };
}

function readGithubPrId(
  env: NodeJS.ProcessEnv,
  eventPayload?: unknown,
): number | null {
  if (eventPayload && typeof eventPayload === "object") {
    const record = eventPayload as Record<string, unknown>;
    const fromPr = record.pull_request;
    if (fromPr && typeof fromPr === "object") {
      const n = positiveInt((fromPr as { number?: unknown }).number);
      if (n !== null) return n;
    }
    const fromNumber = positiveInt(record.number);
    if (fromNumber !== null) return fromNumber;
  }

  const ref = env.GITHUB_REF?.trim();
  if (ref) {
    const match = /^refs\/pull\/(\d+)\//.exec(ref);
    if (match) return Number(match[1]);
  }
  return null;
}

function readGitlabPrId(env: NodeJS.ProcessEnv): number | null {
  return positiveInt(env.CI_MERGE_REQUEST_IID);
}

/**
 * Strict PR-id resolver: reads only the given forge's sources. CI callers
 * pass the forge from `requireCiSource`; the deploy path uses
 * `resolvePrIdAny` (GitHub first, then GitLab).
 */
export function resolvePrId(input: {
  env: NodeJS.ProcessEnv;
  eventPayload?: unknown;
  forge: Forge;
}): Result<number> {
  if (input.forge === "github") {
    const n = readGithubPrId(input.env, input.eventPayload);
    if (n !== null) return { ok: true, value: n };
    return {
      ok: false,
      error: "cannot derive pr id (GitHub pull_request event or GITHUB_REF)",
    };
  }

  const m = readGitlabPrId(input.env);
  if (m !== null) return { ok: true, value: m };
  return {
    ok: false,
    error: "cannot derive pr id (CI_MERGE_REQUEST_IID)",
  };
}

/** Deploy path: forge-blind, GitHub first then GitLab (old aggregator order). */
export function resolvePrIdAny(input: {
  env: NodeJS.ProcessEnv;
  eventPayload?: unknown;
}): Result<number> {
  const github = readGithubPrId(input.env, input.eventPayload);
  if (github !== null) return { ok: true, value: github };
  const gitlab = readGitlabPrId(input.env);
  if (gitlab !== null) return { ok: true, value: gitlab };
  return {
    ok: false,
    error:
      "cannot derive pr id (GitHub pull_request event, GITHUB_REF, or CI_MERGE_REQUEST_IID)",
  };
}

/** Forge → commit-SHA env var name. One map for strict resolution and error copy. */
export function commitShaEnvVar(forge: Forge): "CI_COMMIT_SHA" | "GITHUB_SHA" {
  return forge === "gitlab" ? "CI_COMMIT_SHA" : "GITHUB_SHA";
}

/** Strict commit SHA: reads only the given forge's var. CI callers pass the forge from identity. */
export function resolveCommitSha(
  env: NodeJS.ProcessEnv,
  forge: Forge,
): string | undefined {
  return env[commitShaEnvVar(forge)]?.trim() || undefined;
}

/** Deploy path: forge-blind, GitHub first then GitLab (old aggregator order). */
export function resolveCommitShaAny(env: NodeJS.ProcessEnv): string | undefined {
  return resolveCommitSha(env, "github") ?? resolveCommitSha(env, "gitlab");
}
