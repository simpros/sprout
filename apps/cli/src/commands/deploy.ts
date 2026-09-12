import type { CliContext } from "../context.ts";
import { fail, loadYaml, resolveIdentity } from "../context.ts";
import { parseFlags } from "../flags.ts";
import { mergeServices, type DeployService } from "../services.ts";
import {
  applyDeployAppEnv,
  deployBaseFields,
  type DeployRequest,
  postDeployAndWait,
  resolveDeployHostname,
} from "./deploy-core.ts";

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

  const base = deployBaseFields(yaml.value, identity.value);
  if (!base.ok) return fail(ctx.deps.io, base.error);

  const body: DeployRequest = {
    ...base.value,
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

  const withEnv = await applyDeployAppEnv(
    body,
    ctx.deps,
    yaml.value,
    flags.value.appEnvFile,
    flags.value.appEnv,
  );
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
