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

/**
 * `sprout ci reseed` — re-run the seed job against the existing preview
 * database. No image is built: the app tag comes from the pipeline env
 * (`CI_REGISTRY_IMAGE` + SHA) and the seed tag from `-s`, so the gateway
 * takes the seed-resume path — rows/sessions created between deploys stay
 * intact and no credential rotates (same yaml + flags in, same env out).
 *
 * The body is a `ReseedRequest`, which cannot carry `services` — companions
 * stay as last deployed by construction, not by remembering to omit a field.
 */
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

  const imageRef = resolveImageRef(ctx.deps.env);
  if (!imageRef.ok) return fail(ctx.deps.io, imageRef.error);

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  // Body via the shared deploy assembler (same base fields, health gate, and
  // yaml seed layering as `deploy`); companions stay as last deployed because
  // `ReseedRequest` cannot carry `services`.
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
