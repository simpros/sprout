import type { PreviewSnapshot } from "@sprout/api-client";
import { type DotenvFile, mergeAppEnv } from "../app-env.ts";
import type { CliContext } from "../context.ts";
import {
  fail,
  loadYaml,
  resolveIdentity,
  substituteHostname,
} from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import type { PreviewEnvMap, SproutYaml } from "../yaml.ts";

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
    "--repo",
  ]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);

  if (!flags.value.image) {
    return fail(ctx.deps.io, "deploy requires -i <image>");
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
    env?: PreviewEnvMap;
  } = {
    canonical_repo_id: identity.value.repo,
    pr_id: identity.value.prId,
    slug: yaml.value.slug,
    hostname: substituteHostname(
      yaml.value.preview.hostname,
      identity.value.prId,
    ),
    app_image: flags.value.image,
  };

  if (yaml.value.health) body.health = yaml.value.health;
  if (flags.value.seedImage) body.seed_image = flags.value.seedImage;
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

  const response = await ctx.client.v1.deploy.post(body);
  const result = readEden<PreviewSnapshot>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);

  const data = result.data;
  if (data.status !== "running") {
    return fail(ctx.deps.io, `deploy ended with status: ${data.status}`);
  }
  if (!data.preview_url) {
    return fail(ctx.deps.io, "deploy succeeded without preview_url");
  }
  ctx.deps.io.stdout(`preview_url=${data.preview_url}`);
  return 0;
}
