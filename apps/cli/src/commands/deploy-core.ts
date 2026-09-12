import type { ApiClient, PreviewSnapshot } from "@sprout/api-client";
import { type DotenvFile, mergeAppEnv } from "../app-env.ts";
import type { CliDeps } from "../context.ts";
import { substituteHostname } from "../context.ts";
import { readEden } from "../eden.ts";
import type { Result } from "../result.ts";
import type { DeployService } from "../services.ts";
import type { PreviewEnvMap, SproutYaml } from "../yaml.ts";
import { deployOutcome } from "./deploy-outcome.ts";
import {
  pollBudgetMs,
  pollIntervalMs,
  pollPreviewReady,
} from "./deploy-poll.ts";

/** Shared POST /v1/deploy body — one contract for `deploy` and `ci reseed`. */
export type DeployRequest = {
  canonical_repo_id: string;
  pr_id: number;
  slug: string;
  hostname: string;
  app_image: string;
  health?: SproutYaml["health"];
  seed_image?: string;
  seed_env?: string[];
  seed_arg?: string[];
  app_env?: string[];
  services?: DeployService[];
  env?: PreviewEnvMap;
  reseed?: boolean;
};

export type DeployIdentity = { repo: string; prId: number };

/** Identity + yaml slug/hostname fields every deploy POST needs. */
export function deployBaseFields(
  yaml: SproutYaml,
  identity: DeployIdentity,
): Pick<
  DeployRequest,
  "canonical_repo_id" | "pr_id" | "slug" | "hostname"
> {
  return {
    canonical_repo_id: identity.repo,
    pr_id: identity.prId,
    slug: yaml.slug,
    hostname: substituteHostname(yaml.preview.hostname, identity.prId),
  };
}

/**
 * Merge yaml `preview.app_env` with `--app-env-file` / `--app-env` into
 * `body.app_env`. Shared so deploy and ci reseed cannot drift.
 */
export async function applyDeployAppEnv(
  body: DeployRequest,
  deps: CliDeps,
  yaml: SproutYaml,
  appEnvFile: string[],
  appEnv: string[],
): Promise<Result<DeployRequest>> {
  const dotenvFiles: DotenvFile[] = [];
  for (const filePath of appEnvFile) {
    const resolved = filePath.startsWith("/")
      ? filePath
      : `${deps.cwd}/${filePath}`;
    const raw = await deps.readTextFile(resolved);
    if (raw === null) {
      return { ok: false, error: `cannot read --app-env-file: ${filePath}` };
    }
    dotenvFiles.push({ pathLabel: filePath, content: raw });
  }

  const merged = mergeAppEnv(yaml.preview.app_env, dotenvFiles, appEnv);
  if (!merged.ok) return merged;
  if (merged.value) body.app_env = merged.value;
  return { ok: true, value: body };
}

/**
 * POST /v1/deploy, settle (poll if needed), print `preview_url=`.
 * One settle contract for `sprout deploy` and `sprout ci reseed`.
 */
export async function postDeployAndWait(opts: {
  client: ApiClient;
  deps: CliDeps;
  yaml: SproutYaml;
  identity: DeployIdentity;
  body: DeployRequest;
}): Promise<Result<true>> {
  const response = await opts.client.v1.deploy.post(opts.body);
  const result = readEden<PreviewSnapshot>(response);
  if (!result.ok) return { ok: false, error: result.message };

  let data = result.data;
  const outcome = deployOutcome(data);
  if (outcome.kind === "failed") return { ok: false, error: outcome.message };

  if (outcome.kind !== "ready") {
    const sleep =
      opts.deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = opts.deps.now ?? (() => Date.now());
    let budgetMs: number;
    let intervalMs: number;
    try {
      budgetMs = pollBudgetMs(opts.yaml);
      intervalMs = pollIntervalMs(opts.yaml);
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "invalid_health_duration",
      };
    }

    const poll = await pollPreviewReady<PreviewSnapshot>({
      client: opts.client,
      repo: opts.identity.repo,
      prId: opts.identity.prId,
      budgetMs,
      intervalMs,
      sleep,
      now,
    });
    if (!poll.ok) return poll;
    data = poll.value;
  }

  opts.deps.io.stdout(`preview_url=${data.preview_url}`);
  return { ok: true, value: true };
}
