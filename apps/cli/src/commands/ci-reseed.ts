import type { CliContext } from "../context.ts";
import { fail, loadYaml } from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { resolveImageRef } from "./ci-identity.ts";
import {
  applyDeployEnv,
  buildReseedRequest,
  postDeployAndWait,
} from "./deploy-core.ts";

export async function runCiReseed(
  identity: CiIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, [
    "-s",
    "--seed-env",
    "--seed-env-file",
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

  const imageRef = resolveImageRef(ctx.deps.env, identity);
  if (!imageRef.ok) return fail(ctx.deps.io, imageRef.error);

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  const assembled = buildReseedRequest(yaml.value, identity, {
    appImage: imageRef.value,
    seedImage: flags.value.seedImage,
    seedArg: flags.value.seedArg,
  });
  if (!assembled.ok) return fail(ctx.deps.io, assembled.error);
  const body = assembled.value;

  const withEnv = await applyDeployEnv(body, ctx.deps, yaml.value, {
    appEnvFile: flags.value.appEnvFile,
    appEnv: flags.value.appEnv,
    seedEnvFile: flags.value.seedEnvFile,
    seedEnv: flags.value.seedEnv,
    commitSha: identity.commitSha,
  });
  if (!withEnv.ok) return fail(ctx.deps.io, withEnv.error);

  const settled = await postDeployAndWait({
    client: ctx.client,
    deps: ctx.deps,
    yaml: yaml.value,
    identity,
    body: withEnv.value,
  });
  if (!settled.ok) return fail(ctx.deps.io, settled.error);
  return 0;
}
