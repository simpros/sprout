import type { CliContext } from "../context.ts";
import { fail, loadYaml } from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { resolveImageRef } from "./ci-identity.ts";
import {
  applyDeployEnv,
  deployBaseFields,
  requireHealthWhenSeeding,
  type ReseedRequest,
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

  const imageRef = resolveImageRef(ctx.deps.env, identity.forge);
  if (!imageRef.ok) return fail(ctx.deps.io, imageRef.error);

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);
  const gate = requireHealthWhenSeeding(yaml.value, {
    hasSeed: true,
    seedSource: "-s",
  });
  if (!gate.ok) return fail(ctx.deps.io, gate.error);

  const base = deployBaseFields(yaml.value, identity);
  if (!base.ok) return fail(ctx.deps.io, base.error);

  const body: ReseedRequest = {
    ...base.value,
    app_image: imageRef.value,
    health: yaml.value.health,
    seed_image: flags.value.seedImage,
    reseed: true,
  };
  if (flags.value.seedArg.length > 0) body.seed_arg = flags.value.seedArg;
  if (yaml.value.preview.env) body.env = yaml.value.preview.env;

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
