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
 * comes from the `ready` outcome, never from a fallback cast.
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

  const data = result.data;
  const outcome = deployOutcome(data);
  if (outcome.kind === "failed") return { ok: false, error: outcome.message };

  if (outcome.kind === "ready") {
    opts.deps.io.stdout(`preview_url=${outcome.previewUrl}`);
    return { ok: true, value: outcome.previewUrl };
  }

  const sleep =
    opts.deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.deps.now ?? (() => Date.now());
  const health = resolveHealthSpec(opts.yaml.health);
  if (!health.ok) return { ok: false, error: health.issue.code };
  const budgetMs = health.value.timeoutMs + DEPLOY_POLL_BUFFER_MS;
  const intervalMs = Math.max(200, health.value.intervalMs);

  const poll = await pollPreviewReady({
    client: opts.client,
    repo: opts.identity.repo,
    prId: opts.identity.prId,
    budgetMs,
    intervalMs,
    sleep,
    now,
  });
  if (!poll.ok) return poll;
  // The poller only resolves on a `ready` outcome, carrying its URL —
  // no second `deployOutcome` interpretation here.
  opts.deps.io.stdout(`preview_url=${poll.value}`);
  return { ok: true, value: poll.value };
}

/** `--clear-services` / `--service` mutual exclusion, shared by all deploy paths. */
export function checkServiceFlags(inputs: {
  service: string[];
  clearServices: boolean;
}): Result<true> {
  if (inputs.clearServices && inputs.service.length > 0) {
    return {
      ok: false,
      error: "--clear-services cannot be combined with --service",
    };
  }
  return { ok: true, value: true };
}

/**
 * Seed-implies-health gate. `seedSource` names where the seed image came
 * from so the failure points at the real config: `-s` for CLI flags
 * (`deploy`, `ci reseed`), `seed` for the `.sprout.yaml` seed block
 * (`ci preview`). Optional because non-seed deploys have no source to name;
 * the gate ignores it when `hasSeed` is false.
 */
export function requireHealthWhenSeeding(
  yaml: SproutYaml,
  opts: { hasSeed: boolean; seedSource?: "-s" | "seed" },
): Result<true> {
  if (opts.hasSeed && !yaml.health) {
    return {
      ok: false,
      error:
        opts.seedSource === "seed"
          ? "health block required in .sprout.yaml when seed block is configured"
          : "health block required in .sprout.yaml when -s is passed",
    };
  }
  return { ok: true, value: true };
}

/**
 * One assembler for the deploy POST body — `deploy` and `ci preview` share
 * this instead of recopying the pipeline (clear/service + health-when-seed
 * checks, base fields, health / seed / env / services layering). The next
 * yaml/wire field lands here once.
 */
export type BuildDeployRequestInputs = {
  appImage: string;
  seedArg: string[];
  service: string[];
  clearServices: boolean;
  reseed?: boolean;
} & (
  | { seedImage: string; seedSource: "-s" | "seed" }
  | { seedImage?: undefined; seedSource?: undefined }
);

export function buildDeployRequest(
  yaml: SproutYaml,
  identity: DeployIdentity,
  inputs: BuildDeployRequestInputs,
): Result<DeployRequest> {
  const gate = requireHealthWhenSeeding(
    yaml,
    inputs.seedImage
      ? { hasSeed: true, seedSource: inputs.seedSource }
      : { hasSeed: false },
  );
  if (!gate.ok) return gate;

  const base = deployBaseFields(yaml, identity);
  if (!base.ok) return base;

  const body: DeployRequest = {
    ...base.value,
    app_image: inputs.appImage,
  };
  if (yaml.health) body.health = yaml.health;
  if (inputs.seedImage) body.seed_image = inputs.seedImage;
  if (inputs.seedArg.length > 0) body.seed_arg = inputs.seedArg;
  if (inputs.reseed) body.reseed = true;
  if (yaml.preview.env) body.env = yaml.preview.env;

  const services = resolveDeployServices(yaml, identity.prId, {
    service: inputs.service,
    clearServices: inputs.clearServices,
  });
  if (!services.ok) return services;
  if (services.value) body.services = services.value;
  return { ok: true, value: body };
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
  const flags = checkServiceFlags(inputs);
  if (!flags.ok) return flags;
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
