import type { PreviewSnapshot } from "@sprout/api-client";
import {
  DEFAULT_HEALTH,
  parseDurationMs,
  resolveHostnameValue,
} from "@sprout/preview-env";
import { type DotenvFile, mergeAppEnv } from "../app-env.ts";
import type { CliContext } from "../context.ts";
import { fail, loadYaml, resolveIdentity } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import { hostnameIssueMessage } from "../hostname.ts";
import { mergeServices, type DeployService } from "../services.ts";
import type { PreviewEnvMap, SproutYaml } from "../yaml.ts";
import { deployOutcome } from "./deploy-outcome.ts";

/** Extra budget beyond health.timeout for image pull + replace + optional seed. */
const DEPLOY_POLL_BUFFER_MS = 180_000;

/** Parse `Ns` durations; missing uses fallback. Malformed throws (no silent default). */
function parseSecondsMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const ms = parseDurationMs(raw);
  if (ms === null) {
    throw new Error(`invalid duration (expected Ns): ${raw}`);
  }
  return ms;
}

function pollBudgetMs(yaml: SproutYaml): number {
  return (
    parseSecondsMs(yaml.health?.timeout, DEFAULT_HEALTH.timeoutMs) +
    DEPLOY_POLL_BUFFER_MS
  );
}

function pollIntervalMs(yaml: SproutYaml): number {
  return Math.max(
    200,
    parseSecondsMs(yaml.health?.interval, DEFAULT_HEALTH.intervalMs),
  );
}

function resolveDeployHostname(
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

export async function runDeploy(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, [
    "-i",
    "-s",
    "--seed-env",
    "--seed-arg",
    "--app-env",
    "--app-env-file",
    "--service",
    "--reseed",
    "--clear-services",
    "--repo",
  ]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);

  if (!flags.value.image) {
    return fail(ctx.deps.io, "deploy requires -i <image>");
  }
  if (flags.value.reseed && !flags.value.seedImage) {
    return fail(ctx.deps.io, "--reseed requires -s <seed-image>");
  }
  if (flags.value.clearServices && flags.value.service.length > 0) {
    return fail(
      ctx.deps.io,
      "--clear-services cannot be combined with --service",
    );
  }
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  if (flags.value.seedImage && !yaml.value.health) {
    return fail(
      ctx.deps.io,
      "health block required in .sprout.yaml when -s is passed",
    );
  }

  const identity = await resolveIdentity(ctx.deps, flags.value.repo);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  const hostname = resolveDeployHostname(
    yaml.value.preview.hostname,
    identity.value.prId,
    "preview.hostname",
    "required_template",
  );
  if (!hostname.ok) return fail(ctx.deps.io, hostname.error);

  const body: {
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
  } = {
    canonical_repo_id: identity.value.repo,
    pr_id: identity.value.prId,
    slug: yaml.value.slug,
    hostname: hostname.value,
    app_image: flags.value.image,
  };

  if (yaml.value.health) body.health = yaml.value.health;
  if (flags.value.seedImage) body.seed_image = flags.value.seedImage;
  if (flags.value.seedEnv.length > 0) body.seed_env = flags.value.seedEnv;
  if (flags.value.seedArg.length > 0) body.seed_arg = flags.value.seedArg;
  if (flags.value.reseed) body.reseed = true;
  if (yaml.value.preview.env) body.env = yaml.value.preview.env;

  if (flags.value.clearServices) {
    body.services = [];
  } else {
    const services = mergeServices(
      yaml.value.preview.services,
      flags.value.service,
    );
    if (!services.ok) return fail(ctx.deps.io, services.error);
    if (services.value) {
      const mapped: DeployService[] = [];
      for (const svc of services.value) {
        const entry: DeployService = { name: svc.name, image: svc.image };
        if (svc.hostname) {
          const resolved = resolveDeployHostname(
            svc.hostname,
            identity.value.prId,
            "service hostname",
            "static_or_template",
          );
          if (!resolved.ok) return fail(ctx.deps.io, resolved.error);
          entry.hostname = resolved.value;
        }
        if (svc.path) entry.path = svc.path;
        mapped.push(entry);
      }
      body.services = mapped;
    }
  }

  const dotenvFiles: DotenvFile[] = [];
  for (const filePath of flags.value.appEnvFile) {
    const resolved = filePath.startsWith("/")
      ? filePath
      : `${ctx.deps.cwd}/${filePath}`;
    const raw = await ctx.deps.readTextFile(resolved);
    if (raw === null) {
      return fail(ctx.deps.io, `cannot read --app-env-file: ${filePath}`);
    }
    dotenvFiles.push({ pathLabel: filePath, content: raw });
  }

  const appEnv = mergeAppEnv(
    yaml.value.preview.app_env,
    dotenvFiles,
    flags.value.appEnv,
  );
  if (!appEnv.ok) return fail(ctx.deps.io, appEnv.error);
  if (appEnv.value) body.app_env = appEnv.value;

  const response = await ctx.client.v1.deploy.post(body);
  const result = readEden<PreviewSnapshot>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);

  let data = result.data;
  let outcome = deployOutcome(data);
  if (outcome.kind === "failed") return fail(ctx.deps.io, outcome.message);

  if (outcome.kind !== "ready") {
    const sleep =
      ctx.deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = ctx.deps.now ?? (() => Date.now());
    let deadline: number;
    let interval: number;
    try {
      deadline = now() + pollBudgetMs(yaml.value);
      interval = pollIntervalMs(yaml.value);
    } catch (err) {
      return fail(
        ctx.deps.io,
        err instanceof Error ? err.message : "invalid_health_duration",
      );
    }

    while (true) {
      if (now() >= deadline) {
        return fail(ctx.deps.io, "deploy_timeout");
      }
      const statusResponse = await ctx.client.v1.preview.get({
        query: {
          canonical_repo_id: identity.value.repo,
          pr_id: String(identity.value.prId),
        },
      });
      const statusResult = readEden<PreviewSnapshot>(statusResponse);
      if (!statusResult.ok) return fail(ctx.deps.io, statusResult.message);
      data = statusResult.data;
      outcome = deployOutcome(data);
      if (outcome.kind === "failed") return fail(ctx.deps.io, outcome.message);
      if (outcome.kind === "ready") break;
      await sleep(interval);
    }
  }

  ctx.deps.io.stdout(`preview_url=${data.preview_url}`);
  return 0;
}
