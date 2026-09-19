import type { ApiClient, PreviewSnapshot } from "@sprout/api-client";
import {
  copyServiceExtras,
  requiresDatabase,
  resolveHealthSpec,
  seedRequiresDatabaseMessage,
} from "@sprout/preview-env";
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
import type { Result } from "../result.ts";
import { mergeServices, type DeployService } from "../services.ts";
import type {
  DbSpec,
  ManifestEnvValue,
  PreviewEnvMap,
  SproutYaml,
} from "../yaml.ts";
import { deployOutcome } from "./deploy-outcome.ts";
import { DEPLOY_POLL_BUFFER_MS, pollPreviewReady } from "./deploy-poll.ts";

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
  db?: DbSpec;
  reseed?: boolean;
};

/** A type that cannot carry `services` makes "leave" the default instead of a forgotten field. */
export type ReseedRequest = Omit<DeployRequest, "services"> & {
  reseed: true;
};

export type DeployIdentity = { repo: string; prId: number };

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

export type DeployEnvInputs = {
  appEnvFile: string[];
  appEnv: string[];
  seedEnvFile: string[];
  seedEnv: string[];
  commitSha: string | undefined;
};

export function layerSeedWireOptions(
  yaml: SproutYaml,
  seeding: boolean,
  flagArgs: string[],
): {
  yamlEnv?: Record<string, ManifestEnvValue>;
  seed_arg?: string[];
} {
  const yamlEnv = seeding ? yaml.seed?.env : undefined;
  const seedArgs = [...(seeding ? (yaml.seed?.args ?? []) : []), ...flagArgs];
  return {
    yamlEnv,
    ...(seedArgs.length > 0 ? { seed_arg: seedArgs } : {}),
  };
}

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
    commitSha: inputs.commitSha,
    repo: body.canonical_repo_id,
    // HMAC key is SPROUT_TOKEN only (not local admin fallback) so CI and
    // local agree when the same deploy token is used.
    deployToken: deps.env.SPROUT_TOKEN?.trim() ?? "",
  };

  const resolvedYamlEnv = resolveAppEnvValues(
    yaml.preview.app_env,
    resolveCtx,
    "preview.app_env.",
  );
  if (!resolvedYamlEnv.ok) return resolvedYamlEnv;

  const { yamlEnv: seedYamlEnv } = layerSeedWireOptions(
    yaml,
    Boolean(body.seed_image),
    [],
  );
  const resolvedYamlSeedEnv = resolveAppEnvValues(
    seedYamlEnv,
    resolveCtx,
    "seed.env.",
  );
  if (!resolvedYamlSeedEnv.ok) return resolvedYamlSeedEnv;

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
    resolvedYamlSeedEnv.value.values,
    resolvedYamlSeedEnv.value.requiredKeys,
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
  opts.deps.io.stdout(`preview_url=${poll.value}`);
  return { ok: true, value: poll.value };
}

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
  // A seed job populates a database; with no database the flags have nothing to act on.
  if (
    yaml.db != null &&
    !requiresDatabase(yaml.db.provider) &&
    (inputs.seedImage || inputs.reseed)
  ) {
    return {
      ok: false,
      error: seedRequiresDatabaseMessage(),
    };
  }

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
  const seed = layerSeedWireOptions(
    yaml,
    Boolean(inputs.seedImage),
    inputs.seedArg,
  );
  if (seed.seed_arg) body.seed_arg = seed.seed_arg;
  if (inputs.reseed) body.reseed = true;
  if (yaml.preview.env) body.env = yaml.preview.env;
  if (yaml.db) body.db = yaml.db;

  const services = resolveDeployServices(yaml, identity.prId, {
    service: inputs.service,
    clearServices: inputs.clearServices,
  });
  if (!services.ok) return services;
  if (services.value) body.services = services.value;
  return { ok: true, value: body };
}

export function buildReseedRequest(
  yaml: SproutYaml,
  identity: DeployIdentity,
  inputs: { appImage: string; seedImage: string; seedArg: string[] },
): Result<ReseedRequest> {
  const assembled = buildDeployRequest(yaml, identity, {
    appImage: inputs.appImage,
    seedImage: inputs.seedImage,
    seedSource: "-s",
    seedArg: inputs.seedArg,
    service: [],
    clearServices: false,
    reseed: true,
  });
  if (!assembled.ok) return assembled;
  const { services: _leave, ...rest } = assembled.value;
  return { ok: true, value: { ...rest, reseed: true as const } };
}

/** undefined = leave companions, `[]` = clear, `[...]` = replace. */
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
    copyServiceExtras(svc, entry);
    mapped.push(entry);
  }
  return { ok: true, value: mapped };
}
