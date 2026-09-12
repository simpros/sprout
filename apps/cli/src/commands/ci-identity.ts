import type { CliDeps } from "../context.ts";
import {
  loadEventPayload,
  loadYaml,
  substituteHostname,
} from "../context.ts";
import type { Result } from "../result.ts";

export type CiPipelineSource =
  | "merge_request_event"
  | "pull_request"
  | "pull_request_target";

export type CiSource =
  | { forge: "gitlab"; pipelineSource: "merge_request_event" }
  | {
      forge: "github";
      pipelineSource: "pull_request" | "pull_request_target";
    };

/** Common to all `sprout ci *` subcommands. */
export type CiIdentity = {
  repo: string;
  prId: number;
  pipelineSource: CiPipelineSource;
};

/** Preview-only fields (#120) — image + hostname from yaml. */
export type CiPreviewIdentity = CiIdentity & {
  imageRef: string;
  hostname: string;
};

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

/** Positive MR/PR pipeline evidence — one forge, no empty-string escape hatch. */
export function requireCiSource(env: NodeJS.ProcessEnv): Result<CiSource> {
  const gitlabSource = env.CI_PIPELINE_SOURCE?.trim();
  const githubEvent = env.GITHUB_EVENT_NAME?.trim();

  if (gitlabSource === "merge_request_event") {
    return {
      ok: true,
      value: { forge: "gitlab", pipelineSource: "merge_request_event" },
    };
  }

  if (githubEvent === "pull_request" || githubEvent === "pull_request_target") {
    return {
      ok: true,
      value: { forge: "github", pipelineSource: githubEvent },
    };
  }

  if (gitlabSource) {
    return {
      ok: false,
      error: `sprout ci refuses detached/non-MR pipelines (CI_PIPELINE_SOURCE=${gitlabSource}); run from a merge-request pipeline`,
    };
  }

  if (githubEvent) {
    return {
      ok: false,
      error: `sprout ci refuses detached/non-MR pipelines (GITHUB_EVENT_NAME=${githubEvent}); run from a pull_request workflow`,
    };
  }

  return {
    ok: false,
    error:
      "sprout ci must run in a merge-request or pull-request pipeline (set CI_PIPELINE_SOURCE=merge_request_event or GITHUB_EVENT_NAME=pull_request)",
  };
}

function resolveCiRepo(
  source: CiSource,
  env: NodeJS.ProcessEnv,
): Result<string> {
  if (source.forge === "gitlab") {
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

function resolveGitlabPrId(env: NodeJS.ProcessEnv): Result<number> {
  const prId = positiveInt(env.CI_MERGE_REQUEST_IID);
  if (prId !== null) return { ok: true, value: prId };
  return {
    ok: false,
    error:
      "sprout ci must run in a merge-request pipeline (set CI_MERGE_REQUEST_IID)",
  };
}

function resolveGithubPrId(
  env: NodeJS.ProcessEnv,
  eventPayload: unknown | undefined,
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
    error:
      "sprout ci must run in a pull-request workflow (GitHub pull_request event or GITHUB_REF)",
  };
}

export function resolveImageRef(env: NodeJS.ProcessEnv): Result<string> {
  const registry = env.CI_REGISTRY_IMAGE?.trim();
  const sha = env.CI_COMMIT_SHA?.trim() || env.GITHUB_SHA?.trim() || "";
  if (!registry || !sha) {
    return {
      ok: false,
      error:
        "cannot derive image ref (set CI_REGISTRY_IMAGE and CI_COMMIT_SHA or GITHUB_SHA)",
    };
  }
  return { ok: true, value: `${registry}:${sha}` };
}

/**
 * Group-level CI identity: forge-scoped repo + PR under requireCiSource.
 * Does not require image ref or .sprout.yaml (preview-only).
 */
export async function resolveCiIdentity(
  deps: CliDeps,
): Promise<Result<CiIdentity>> {
  const source = requireCiSource(deps.env);
  if (!source.ok) return source;

  const repo = resolveCiRepo(source.value, deps.env);
  if (!repo.ok) return repo;

  if (source.value.forge === "gitlab") {
    const prId = resolveGitlabPrId(deps.env);
    if (!prId.ok) return prId;
    return {
      ok: true,
      value: {
        repo: repo.value,
        prId: prId.value,
        pipelineSource: source.value.pipelineSource,
      },
    };
  }

  const event = await loadEventPayload(deps);
  if (!event.ok) return event;

  const prId = resolveGithubPrId(deps.env, event.value);
  if (!prId.ok) return prId;

  return {
    ok: true,
    value: {
      repo: repo.value,
      prId: prId.value,
      pipelineSource: source.value.pipelineSource,
    },
  };
}

/** Preview (#120): group identity plus image ref and hostname from yaml. */
export async function resolveCiPreviewIdentity(
  deps: CliDeps,
): Promise<Result<CiPreviewIdentity>> {
  const base = await resolveCiIdentity(deps);
  if (!base.ok) return base;

  const imageRef = resolveImageRef(deps.env);
  if (!imageRef.ok) return imageRef;

  const yaml = await loadYaml(deps);
  if (!yaml.ok) return yaml;

  return {
    ok: true,
    value: {
      ...base.value,
      imageRef: imageRef.value,
      hostname: substituteHostname(yaml.value.preview.hostname, base.value.prId),
    },
  };
}
