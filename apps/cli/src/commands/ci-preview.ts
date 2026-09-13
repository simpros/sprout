import type { CliContext } from "../context.ts";
import {
  defaultRunCommand,
  defaultWriteTextFile,
  fail,
  loadYaml,
} from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { Result } from "../result.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import {
  applyDeployEnv,
  deployBaseFields,
  postDeployAndWait,
  resolveDeployServices,
  type DeployRequest,
} from "./deploy-core.ts";
import { fetchPreviewLogs, parseTailFlag, printLogs } from "./logs.ts";

/** Log lines dumped from the gateway on a failed deploy. */
export const DEFAULT_CI_PREVIEW_TAIL = 200;

/**
 * Default dotenv artifact (relative to the workspace root): GitLab
 * `artifacts:reports:dotenv` picks up `PREVIEW_URL` for `environment:url`.
 */
export const DEFAULT_PREVIEW_DOTENV_FILE = "sprout-preview.env";

/**
 * Derive the seed tag from the app tag: `<registry-path>-seed:<sha>`.
 * The app tag always comes from the pipeline convention
 * (`CI_REGISTRY_IMAGE` + SHA), so it always carries a `:tag` suffix.
 */
export function resolveSeedImageRef(appImageRef: string): Result<string> {
  const cut = appImageRef.lastIndexOf(":");
  if (cut <= 0 || cut === appImageRef.length - 1) {
    return {
      ok: false,
      error: `cannot derive seed image ref from ${appImageRef}`,
    };
  }
  return {
    ok: true,
    value: `${appImageRef.slice(0, cut)}-seed${appImageRef.slice(cut)}`,
  };
}

/**
 * `docker build -f <dockerfile> -t <ref> .` then `docker push <ref>`.
 * The docker CLI inherits the job env, so dind (`DOCKER_HOST`, TLS) and
 * registry auth work unchanged. Build output streams to the job log;
 * only the exit code is captured.
 */
async function buildAndPush(
  ctx: CliContext,
  label: string,
  dockerfile: string,
  ref: string,
): Promise<Result<true>> {
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const build = await run(
    ["docker", "build", "-f", dockerfile, "-t", ref, "."],
    { cwd: ctx.deps.cwd },
  );
  if (build.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image build failed (exit ${build.exitCode})`,
    };
  }
  const push = await run(["docker", "push", ref], { cwd: ctx.deps.cwd });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      error: `${label} image push failed (exit ${push.exitCode})`,
    };
  }
  return { ok: true, value: true };
}

/**
 * `sprout ci preview` — build + push the app image (and the seed image when
 * `.sprout.yaml` configures `seed`), deploy with the resolved env, and on a
 * healthy preview emit `preview_url=` plus the dotenv artifact. On failure
 * the gateway log tail is printed first, then the deploy error exits
 * non-zero. Settling reuses `postDeployAndWait` — there is no second deploy
 * implementation here.
 */
export async function runCiPreview(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, [
    "--app-env",
    "--app-env-file",
    "--seed-env",
    "--seed-env-file",
    "--seed-arg",
    "--service",
    "--clear-services",
    "--tail",
    "--dotenv-file",
  ]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }
  if (flags.value.clearServices && flags.value.service.length > 0) {
    return fail(
      ctx.deps.io,
      "--clear-services cannot be combined with --service",
    );
  }

  const tail = parseTailFlag(flags.value.tail);
  if (!tail.ok) return fail(ctx.deps.io, tail.error);
  const tailN = tail.value ?? DEFAULT_CI_PREVIEW_TAIL;

  const dotenvRaw = flags.value.dotenvFile?.trim();
  const dotenvFile =
    dotenvRaw && dotenvRaw.length > 0 ? dotenvRaw : DEFAULT_PREVIEW_DOTENV_FILE;
  const dotenvPath = dotenvFile.startsWith("/")
    ? dotenvFile
    : `${ctx.deps.cwd}/${dotenvFile}`;

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  const appDockerfile = yaml.value.build?.dockerfile ?? "Dockerfile";
  const seedDockerfile = yaml.value.seed?.dockerfile;
  if (seedDockerfile && !yaml.value.health) {
    return fail(
      ctx.deps.io,
      "health block required in .sprout.yaml when -s is passed",
    );
  }

  const app = await buildAndPush(ctx, "app", appDockerfile, identity.imageRef);
  if (!app.ok) return fail(ctx.deps.io, app.error);

  let seedImage: string | undefined;
  if (seedDockerfile) {
    const ref = resolveSeedImageRef(identity.imageRef);
    if (!ref.ok) return fail(ctx.deps.io, ref.error);
    const seed = await buildAndPush(ctx, "seed", seedDockerfile, ref.value);
    if (!seed.ok) return fail(ctx.deps.io, seed.error);
    seedImage = ref.value;
  }

  const base = deployBaseFields(yaml.value, identity);
  if (!base.ok) return fail(ctx.deps.io, base.error);

  const body: DeployRequest = {
    ...base.value,
    app_image: identity.imageRef,
  };
  if (yaml.value.health) body.health = yaml.value.health;
  if (seedImage) body.seed_image = seedImage;
  if (flags.value.seedArg.length > 0) body.seed_arg = flags.value.seedArg;
  if (yaml.value.preview.env) body.env = yaml.value.preview.env;

  const services = resolveDeployServices(yaml.value, identity.prId, {
    service: flags.value.service,
    clearServices: flags.value.clearServices,
  });
  if (!services.ok) return fail(ctx.deps.io, services.error);
  if (services.value) body.services = services.value;

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
  if (!settled.ok) {
    const logs = await fetchPreviewLogs(ctx.client, {
      repo: identity.repo,
      prId: identity.prId,
      tail: tailN,
    });
    if (logs.ok) {
      printLogs(ctx.deps.io, logs.value);
    } else {
      ctx.deps.io.stderr(`warning: preview log dump failed: ${logs.error}`);
    }
    return fail(ctx.deps.io, settled.error);
  }

  const write = ctx.deps.writeTextFile ?? defaultWriteTextFile;
  try {
    await write(dotenvPath, `PREVIEW_URL=${settled.value}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(ctx.deps.io, `cannot write dotenv file ${dotenvPath}: ${detail}`);
  }
  return 0;
}
