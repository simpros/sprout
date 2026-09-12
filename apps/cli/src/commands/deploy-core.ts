import type { ApiClient, PreviewSnapshot } from "@sprout/api-client";
import {
  resolveHealthSpec,
  resolveHostnameValue,
} from "@sprout/preview-env";
import { type DotenvFile, mergeAppEnv } from "../app-env.ts";
import type { CliDeps } from "../context.ts";
import { readEden } from "../eden.ts";
import { hostnameIssueMessage } from "../hostname.ts";
import type { Result } from "../result.ts";
import type { DeployService } from "../services.ts";
import type { PreviewEnvMap, SproutYaml } from "../yaml.ts";
import { deployOutcome } from "./deploy-outcome.ts";
import { pollPreviewReady } from "./deploy-poll.ts";

/** Extra budget beyond health.timeout for image pull + replace + optional seed. */
const DEPLOY_POLL_BUFFER_MS = 180_000;

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

/** Canonical hostname for `preview.hostname` / service hostnames. */
export function resolveDeployHostname(
  raw: string,
  prId: number,
  label: string,
  mode: "required_template" | "static_or_template",
): { ok: true; value: string } | { ok: false; error: string } {
  const resolved = resolveHostnameValue(raw, prId, mode);
  if (!resolved.ok) {
    return {
      ok: false,
      error: hostnameIssueMessage(label, resolved.issue, { prId }),
    };
  }
  return resolved;
}

/** Identity + yaml slug/hostname fields every deploy POST needs. */
export function deployBaseFields(
  yaml: SproutYaml,
  identity: DeployIdentity,
): Result<
  Pick<DeployRequest, "canonical_repo_id" | "pr_id" | "slug" | "hostname">
> {
  const hostname = resolveDeployHostname(
    yaml.preview.hostname,
    identity.prId,
    "preview.hostname",
    "required_template",
  );
  if (!hostname.ok) return hostname;
  return {
    ok: true,
    value: {
      canonical_repo_id: identity.repo,
      pr_id: identity.prId,
      slug: yaml.slug,
      hostname: hostname.value,
    },
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
    const health = resolveHealthSpec(opts.yaml.health);
    if (!health.ok) return { ok: false, error: health.issue.code };
    const budgetMs = health.value.timeoutMs + DEPLOY_POLL_BUFFER_MS;
    const intervalMs = Math.max(200, health.value.intervalMs);

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
