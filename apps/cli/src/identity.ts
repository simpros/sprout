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

/** Forge-scoped repo URL from CI env (no git-remote fallback). */
export function resolveRepoForForge(
  forge: Forge,
  env: NodeJS.ProcessEnv,
): Result<string> {
  if (forge === "gitlab") {
    const gitlab = env.CI_PROJECT_URL?.trim();
    if (gitlab) {
      return { ok: true, value: gitlab.replace(/\.git$/, "") };
    }
    return {
      ok: false,
      error: "cannot derive canonical repo id (set CI_PROJECT_URL)",
    };
  }

  const github = env.GITHUB_REPOSITORY?.trim();
  if (github) {
    return { ok: true, value: `https://github.com/${github}` };
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
  const github = resolveRepoForForge("github", input.env);
  if (github.ok) return github;

  const gitlab = resolveRepoForForge("gitlab", input.env);
  if (gitlab.ok) return gitlab;

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

export function resolveGithubPrId(
  env: NodeJS.ProcessEnv,
  eventPayload?: unknown,
): Result<number> {
  if (eventPayload && typeof eventPayload === "object") {
    const record = eventPayload as Record<string, unknown>;
    const fromPr = record.pull_request;
    if (fromPr && typeof fromPr === "object") {
      const n = positiveInt((fromPr as { number?: unknown }).number);
      if (n !== null) return { ok: true, value: n };
    }
    const fromNumber = positiveInt(record.number);
    if (fromNumber !== null) return { ok: true, value: fromNumber };
  }

  const ref = env.GITHUB_REF?.trim();
  if (ref) {
    const match = /^refs\/pull\/(\d+)\//.exec(ref);
    if (match) return { ok: true, value: Number(match[1]) };
  }

  return {
    ok: false,
    error: "cannot derive pr id (GitHub pull_request event or GITHUB_REF)",
  };
}

export function resolveGitlabPrId(env: NodeJS.ProcessEnv): Result<number> {
  const gitlab = positiveInt(env.CI_MERGE_REQUEST_IID);
  if (gitlab !== null) return { ok: true, value: gitlab };
  return {
    ok: false,
    error: "cannot derive pr id (CI_MERGE_REQUEST_IID)",
  };
}

/** Deploy/teardown: GitHub reader, then GitLab (forge-blind aggregator). */
export function resolvePrId(input: {
  env: NodeJS.ProcessEnv;
  eventPayload?: unknown;
}): Result<number> {
  const github = resolveGithubPrId(input.env, input.eventPayload);
  if (github.ok) return github;

  const gitlab = resolveGitlabPrId(input.env);
  if (gitlab.ok) return gitlab;

  return {
    ok: false,
    error:
      "cannot derive pr id (GitHub pull_request event, GITHUB_REF, or CI_MERGE_REQUEST_IID)",
  };
}
