import type { CliContext } from "../context.ts";
import { fail, loadYaml, resolveIdentity } from "../context.ts";
import { parseFlags } from "../flags.ts";
import { resolveCommitShaAny } from "../identity.ts";
import {
  applyDeployEnv,
  buildDeployRequest,
  postDeployAndWait,
  type BuildDeployRequestInputs,
} from "./deploy-core.ts";

export async function runDeploy(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, [
    "-i",
    "-s",
    "--seed-env",
    "--seed-env-file",
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
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  const identity = await resolveIdentity(ctx.deps, flags.value.repo);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  const deployInputs: BuildDeployRequestInputs = flags.value.seedImage
    ? {
        appImage: flags.value.image,
        seedImage: flags.value.seedImage,
        seedSource: "-s",
        seedArg: flags.value.seedArg,
        service: flags.value.service,
        clearServices: flags.value.clearServices,
        reseed: flags.value.reseed,
      }
    : {
        appImage: flags.value.image,
        seedArg: flags.value.seedArg,
        service: flags.value.service,
        clearServices: flags.value.clearServices,
        reseed: flags.value.reseed,
      };
  const assembled = buildDeployRequest(yaml.value, identity.value, deployInputs);
  if (!assembled.ok) return fail(ctx.deps.io, assembled.error);
  const body = assembled.value;

  const withEnv = await applyDeployEnv(body, ctx.deps, yaml.value, {
    appEnvFile: flags.value.appEnvFile,
    appEnv: flags.value.appEnv,
    seedEnvFile: flags.value.seedEnvFile,
    seedEnv: flags.value.seedEnv,
    commitSha: resolveCommitShaAny(ctx.deps.env),
  });
  if (!withEnv.ok) return fail(ctx.deps.io, withEnv.error);

  const settled = await postDeployAndWait({
    client: ctx.client,
    deps: ctx.deps,
    yaml: yaml.value,
    identity: identity.value,
    body: withEnv.value,
  });
  if (!settled.ok) return fail(ctx.deps.io, settled.error);
  return 0;
}
