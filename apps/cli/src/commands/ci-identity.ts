import type { CliDeps } from "../context.ts";
import { loadEventPayload, loadYaml } from "../context.ts";
import {
  resolvePrId,
  resolveRepoForForge,
  type Forge,
} from "../identity.ts";
import { resolveDeployHostname } from "../hostname.ts";
import type { Result } from "../result.ts";

export type CiSource =
  | { forge: "gitlab"; pipelineSource: "merge_request_event" }
  | {
      forge: "github";
      pipelineSource: "pull_request" | "pull_request_target";
    };

/** Common to all `sprout ci *` subcommands — keeps the forge discriminant. */
export type CiIdentity = CiSource & {
  repo: string;
  prId: number;
};

/** Preview-only fields (#120) — image + hostname from yaml. */
export type CiPreviewIdentity = CiIdentity & {
  imageRef: string;
  hostname: string;
};

/** Coherence check over both forges' pipeline claims — not a priority chain. */
export function requireCiSource(env: NodeJS.ProcessEnv): Result<CiSource> {
  const gitlabSource = env.CI_PIPELINE_SOURCE?.trim();
  const githubEvent = env.GITHUB_EVENT_NAME?.trim();
  const gitlabPositive = gitlabSource === "merge_request_event";
  const githubPositive =
    githubEvent === "pull_request" || githubEvent === "pull_request_target";

  if (gitlabPositive && githubPositive) {
    return {
      ok: false,
      error: `sprout ci refuses ambiguous pipeline (CI_PIPELINE_SOURCE=${gitlabSource} and GITHUB_EVENT_NAME=${githubEvent}); run in a single merge-request or pull-request pipeline`,
    };
  }

  if (gitlabPositive) {
    return {
      ok: true,
      value: { forge: "gitlab", pipelineSource: "merge_request_event" },
    };
  }

  if (githubEvent === "pull_request" || githubEvent === "pull_request_target") {
    return {
      ok: true,
      value: {
        forge: "github",
        pipelineSource: githubEvent,
      },
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

export function resolveImageRef(
  env: NodeJS.ProcessEnv,
  forge: Forge,
): Result<string> {
  const registry = env.CI_REGISTRY_IMAGE?.trim();
  const sha =
    forge === "gitlab"
      ? env.CI_COMMIT_SHA?.trim()
      : env.GITHUB_SHA?.trim();
  if (!registry || !sha) {
    const shaVar = forge === "gitlab" ? "CI_COMMIT_SHA" : "GITHUB_SHA";
    return {
      ok: false,
      error: `cannot derive image ref (set CI_REGISTRY_IMAGE and ${shaVar})`,
    };
  }
  return { ok: true, value: `${registry}:${sha}` };
}

function ciPrIdError(forge: Forge): string {
  return forge === "gitlab"
    ? "sprout ci must run in a merge-request pipeline (set CI_MERGE_REQUEST_IID)"
    : "sprout ci must run in a pull-request workflow (GitHub pull_request event or GITHUB_REF)";
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

  const repo = resolveRepoForForge(source.value.forge, deps.env);
  if (!repo.ok) return repo;

  let prId: Result<number>;
  if (source.value.forge === "gitlab") {
    prId = resolvePrId({ env: deps.env, forge: "gitlab" });
  } else {
    const event = await loadEventPayload(deps);
    if (!event.ok) return event;
    prId = resolvePrId({
      env: deps.env,
      eventPayload: event.value,
      forge: "github",
    });
  }
  if (!prId.ok) {
    return { ok: false, error: ciPrIdError(source.value.forge) };
  }

  return {
    ok: true,
    value: { ...source.value, repo: repo.value, prId: prId.value },
  };
}

/** Preview (#120): group identity plus image ref and hostname from yaml. */
export async function resolveCiPreviewIdentity(
  deps: CliDeps,
): Promise<Result<CiPreviewIdentity>> {
  const base = await resolveCiIdentity(deps);
  if (!base.ok) return base;

  const imageRef = resolveImageRef(deps.env, base.value.forge);
  if (!imageRef.ok) return imageRef;

  const yaml = await loadYaml(deps);
  if (!yaml.ok) return yaml;

  const hostname = resolveDeployHostname(
    yaml.value.preview.hostname,
    base.value.prId,
    "preview.hostname",
    "required_template",
  );
  if (!hostname.ok) return hostname;

  return {
    ok: true,
    value: {
      ...base.value,
      imageRef: imageRef.value,
      hostname: hostname.value,
    },
  };
}
