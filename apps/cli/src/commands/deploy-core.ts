import type { ApiClient, PreviewSnapshot } from "@sprout/api-client";
import { resolveHealthSpec } from "@sprout/preview-env";
import {
  mergeAppEnv,
  mergeSeedEnv,
  readEnvFiles,
} from "../app-env.ts";
import {
  expandAppEnvValue,
  resolveAppEnvValues,
} from "../app-env-values.ts";
import type { CliDeps } from "../context.ts";
import { readEden } from "../eden.ts";
import { resolveDeployHostname } from "../hostname.ts";
import { resolveCommitSha } from "../identity.ts";
import type { Result } from "../result.ts";
import { mergeServices, type DeployService } from "../services.ts";
import type { PreviewEnvMap, SproutYaml } from "../yaml.ts";
import { deployOutcome } from "./deploy-outcome.ts";
import { DEPLOY_POLL_BUFFER_MS, pollPreviewReady } from "./deploy-poll.ts";

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

/**
 * `ci reseed` body: wire `services` has three meanings (absent = leave
 * companions, `[]` = clear, `[...]` = replace) and reseed must always
 * leave. A type that cannot carry `services` makes "leave" the default
 * instead of a forgotten field plus a comment.
 */
export type ReseedRequest = Omit<DeployRequest, "services"> & {
  reseed: true;
};

export type DeployIdentity = { repo: string; prId: number };

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
 * Env inputs for a deploy POST. `deploy` takes these from flags;
 * `ci reseed` takes the same flags (image comes from pipeline env instead).
 */
export type DeployEnvInputs = {
  appEnvFile: string[];
  appEnv: string[];
  seedEnvFile: string[];
  seedEnv: string[];
};

/**
 * Merge yaml `preview.app_env` with `SPROUT_APP_ENV` / `--app-env-file` /
 * `--app-env` into `app_env`, and `SPROUT_SEED_ENV` / `--seed-env-file` /
 * `--seed-env` into `seed_env`. Owns the full yaml→wire pipeline so deploy
 * and ci reseed cannot drift: yaml templates (`{hostname}` / `{pr_id}` /
 * `{commit_sha}`) and `generate: stable_per_pr` (HMAC via `SPROUT_TOKEN`)
 * resolve first via `resolveAppEnvValues`, then dotenv files and flags
 * overwrite per key, with one placeholder expansion after merge
 * (`expandAppEnvValue`); `{ required: true }` keys missing after all layers
 * fail naming the key. Returns a new body; `body` is treated as read-only.
 */
export async function applyDeployEnv<T extends DeployRequest>(
  body: T,
  deps: CliDeps,
  yaml: SproutYaml,
  inputs: DeployEnvInputs,
): Promise<Result<T>> {
  const [appEnvFiles, seedEnvFiles] = await Promise.all([
    readEnvFiles(deps, "SPROUT_APP_ENV", inputs.appEnvFile, "--app-env-file"),
    readEnvFiles(
      deps,
      "SPROUT_SEED_ENV",
      inputs.seedEnvFile,
      "--seed-env-file",
    ),
  ]);
  if (!appEnvFiles.ok) return appEnvFiles;
  if (!seedEnvFiles.ok) return seedEnvFiles;

  const resolveCtx = {
    hostname: body.hostname,
    prId: body.pr_id,
    commitSha: resolveCommitSha(deps.env),
    repo: body.canonical_repo_id,
    // HMAC key is SPROUT_TOKEN only (not local admin fallback) so CI and
    // local agree when the same deploy token is used.
    deployToken: deps.env.SPROUT_TOKEN?.trim() ?? "",
  };

  const resolvedYamlEnv = resolveAppEnvValues(
    yaml.preview.app_env,
    resolveCtx,
  );
  if (!resolvedYamlEnv.ok) return resolvedYamlEnv;

  const expandValue = (value: string) => expandAppEnvValue(value, resolveCtx);

  const appEnv = mergeAppEnv(
    resolvedYamlEnv.value.values,
    resolvedYamlEnv.value.requiredKeys,
    appEnvFiles.value,
    inputs.appEnv,
    expandValue,
  );
  if (!appEnv.ok) return appEnv;

  const seedEnv = mergeSeedEnv(
    seedEnvFiles.value,
    inputs.seedEnv,
    expandValue,
  );
  if (!seedEnv.ok) return seedEnv;

  const next = { ...body };
  if (appEnv.value) next.app_env = appEnv.value;
  if (seedEnv.value) next.seed_env = seedEnv.value;
  return { ok: true, value: next };
}

/**
 * POST /v1/deploy, settle (poll if needed), print `preview_url=`.
 * One settle contract for `sprout deploy`, `sprout ci reseed`, and
 * `sprout ci preview`. Resolves with the healthy preview URL (printed
 * above) so callers can persist it (e.g. the CI dotenv artifact) — the URL
 * is only returned once the preview is actually healthy.
 */
export async function postDeployAndWait(opts: {
  client: ApiClient;
  deps: CliDeps;
  yaml: SproutYaml;
  identity: DeployIdentity;
  body: DeployRequest;
}): Promise<Result<string>> {
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
  // Ready (immediate or polled) guarantees a non-empty preview_url.
  const previewUrl = typeof data.preview_url === "string" ? data.preview_url : "";
  return { ok: true, value: previewUrl };
}

/**
 * Companion services for a deploy POST from yaml `preview.services` plus
 * `--service` / `--clear-services`. Shared by `sprout deploy` and
 * `sprout ci preview` so the leave/clear/replace contract cannot drift:
 * undefined = leave companions, `[]` = clear, `[...]` = replace.
 */
export function resolveDeployServices(
  yaml: SproutYaml,
  prId: number,
  inputs: { service: string[]; clearServices: boolean },
): Result<DeployService[] | undefined> {
  if (inputs.clearServices) return { ok: true, value: [] };
  const services = mergeServices(yaml.preview.services, inputs.service);
  if (!services.ok) return services;
  if (!services.value) return { ok: true, value: undefined };
  const mapped: DeployService[] = [];
  for (const svc of services.value) {
    const entry: DeployService = { name: svc.name, image: svc.image };
    if (svc.hostname) {
      const resolved = resolveDeployHostname(
        svc.hostname,
        prId,
        "service hostname",
        "static_or_template",
      );
      if (!resolved.ok) return resolved;
      entry.hostname = resolved.value;
    }
    if (svc.path) entry.path = svc.path;
    mapped.push(entry);
  }
  return { ok: true, value: mapped };
}
