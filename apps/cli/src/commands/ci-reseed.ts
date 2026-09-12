import type { PreviewSnapshot } from "@sprout/api-client";
import { resolveHostnameValue } from "@sprout/preview-env";
import { type DotenvFile, mergeAppEnv } from "../app-env.ts";
import type { CliContext } from "../context.ts";
import { authedClient, fail, loadYaml } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import { hostnameIssueMessage } from "../hostname.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { resolveImageRef } from "./ci-identity.ts";
import { deployOutcome } from "./deploy-outcome.ts";
import {
  pollBudgetMs,
  pollIntervalMs,
  pollPreviewReady,
} from "./deploy-poll.ts";

/**
 * `sprout ci reseed` — re-run the seed job against the existing preview
 * database. No image is built: the app tag comes from the pipeline env
 * (`CI_REGISTRY_IMAGE` + SHA) and the seed tag from `-s`, so the gateway
 * takes the seed-resume path — rows/sessions created between deploys stay
 * intact and no credential rotates (same yaml + flags in, same env out).
 */
export async function runCiReseed(
  identity: CiIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, [
    "-s",
    "--seed-env",
    "--seed-arg",
    "--app-env",
    "--app-env-file",
  ]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }
  if (!flags.value.seedImage) {
    return fail(ctx.deps.io, "ci reseed requires -s <seed-image>");
  }

  const imageRef = resolveImageRef(ctx.deps.env);
  if (!imageRef.ok) return fail(ctx.deps.io, imageRef.error);

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);
  if (!yaml.value.health) {
    return fail(
      ctx.deps.io,
      "health block required in .sprout.yaml when -s is passed",
    );
  }

  const client = await authedClient(ctx.deps);
  if (!client.ok) return fail(ctx.deps.io, client.error);

  const hostname = resolveHostnameValue(
    yaml.value.preview.hostname,
    identity.prId,
    "required_template",
  );
  if (!hostname.ok)
    return fail(
      ctx.deps.io,
      hostnameIssueMessage("preview.hostname", hostname.issue, {
        prId: identity.prId,
      }),
    );

  const body: {
    canonical_repo_id: string;
    pr_id: number;
    slug: string;
    hostname: string;
    app_image: string;
    health: typeof yaml.value.health;
    seed_image: string;
    seed_env?: string[];
    seed_arg?: string[];
    app_env?: string[];
    env?: typeof yaml.value.preview.env;
    reseed: boolean;
  } = {
    canonical_repo_id: identity.repo,
    pr_id: identity.prId,
    slug: yaml.value.slug,
    hostname: hostname.value,
    app_image: imageRef.value,
    health: yaml.value.health,
    seed_image: flags.value.seedImage,
    reseed: true,
  };
  if (flags.value.seedEnv.length > 0) body.seed_env = flags.value.seedEnv;
  if (flags.value.seedArg.length > 0) body.seed_arg = flags.value.seedArg;
  if (yaml.value.preview.env) body.env = yaml.value.preview.env;

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

  const response = await client.value.v1.deploy.post(body);
  const result = readEden<PreviewSnapshot>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);

  let data = result.data;
  const outcome = deployOutcome(data);
  if (outcome.kind === "failed") return fail(ctx.deps.io, outcome.message);

  if (outcome.kind !== "ready") {
    const sleep =
      ctx.deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = ctx.deps.now ?? (() => Date.now());
    let budgetMs: number;
    let intervalMs: number;
    try {
      budgetMs = pollBudgetMs(yaml.value);
      intervalMs = pollIntervalMs(yaml.value);
    } catch (err) {
      return fail(
        ctx.deps.io,
        err instanceof Error ? err.message : "invalid_health_duration",
      );
    }

    const poll = await pollPreviewReady<PreviewSnapshot>({
      client: client.value,
      repo: identity.repo,
      prId: identity.prId,
      budgetMs,
      intervalMs,
      sleep,
      now,
    });
    if (!poll.ok) return fail(ctx.deps.io, poll.error);
    data = poll.value;
  }

  ctx.deps.io.stdout(`preview_url=${data.preview_url}`);
  return 0;
}
