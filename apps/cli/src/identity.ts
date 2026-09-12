import type { Result } from "./result.ts";

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

export function resolveCanonicalRepoId(input: {
  env: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
}): Result<string> {
  const github = input.env.GITHUB_REPOSITORY?.trim();
  if (github) {
    return { ok: true, value: `https://github.com/${github}` };
  }

  const gitlab = input.env.CI_PROJECT_URL?.trim();
  if (gitlab) {
    return { ok: true, value: gitlab.replace(/\.git$/, "") };
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

export function resolvePrId(input: {
  env: NodeJS.ProcessEnv;
  eventPayload?: unknown;
}): Result<number> {
  const payload = input.eventPayload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const fromPr = record.pull_request;
    if (fromPr && typeof fromPr === "object") {
      const n = positiveInt((fromPr as { number?: unknown }).number);
      if (n !== null) return { ok: true, value: n };
    }
    const fromNumber = positiveInt(record.number);
    if (fromNumber !== null) return { ok: true, value: fromNumber };
  }

  const ref = input.env.GITHUB_REF?.trim();
  if (ref) {
    const match = /^refs\/pull\/(\d+)\//.exec(ref);
    if (match) return { ok: true, value: Number(match[1]) };
  }

  const gitlab = positiveInt(input.env.CI_MERGE_REQUEST_IID);
  if (gitlab !== null) return { ok: true, value: gitlab };

  return {
    ok: false,
    error:
      "cannot derive pr id (GitHub pull_request event, GITHUB_REF, or CI_MERGE_REQUEST_IID)",
  };
}

export type CiIdentity = {
  repo: string;
  prId: number;
  pipelineSource: string;
  imageRef: string;
};

export function resolveCiIdentity(input: {
  env: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
  eventPayload?: unknown;
}): Result<CiIdentity> {
  const repo = resolveCanonicalRepoId({
    env: input.env,
    gitRemoteUrl: input.gitRemoteUrl,
  });
  if (!repo.ok) return repo;

  const gitlabSource = input.env.CI_PIPELINE_SOURCE?.trim();
  if (gitlabSource && gitlabSource !== "merge_request_event") {
    return {
      ok: false,
      error: `sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=${gitlabSource}); run from a merge-request pipeline`,
    };
  }

  const githubEvent = input.env.GITHUB_EVENT_NAME?.trim();
  if (
    githubEvent &&
    githubEvent !== "pull_request" &&
    githubEvent !== "pull_request_target"
  ) {
    return {
      ok: false,
      error: `sprout ci refuses detached/non-MR pipelines (GITHUB_EVENT_NAME=${githubEvent}); run from a pull_request workflow`,
    };
  }

  const pipelineSource = gitlabSource || githubEvent || "";

  const prId = resolvePrId({
    env: input.env,
    eventPayload: input.eventPayload,
  });
  if (!prId.ok) {
    return {
      ok: false,
      error:
        "sprout ci must run in a merge-request or pull-request pipeline (set CI_MERGE_REQUEST_IID or GitHub pull_request context)",
    };
  }

  const registry = input.env.CI_REGISTRY_IMAGE?.trim();
  const sha =
    input.env.CI_COMMIT_SHA?.trim() || input.env.GITHUB_SHA?.trim() || "";
  if (!registry || !sha) {
    return {
      ok: false,
      error:
        "cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA or GITHUB_SHA)",
    };
  }

  return {
    ok: true,
    value: {
      repo: repo.value,
      prId: prId.value,
      pipelineSource,
      imageRef: `${registry}:${sha}`,
    },
  };
}
