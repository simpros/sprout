import type { ApiClient } from "@sprout/api-client";
import {
  requiresDatabase,
  seedRequiresDatabaseMessage,
} from "@sprout/preview-env";
import {
  defaultWriteTextFile,
  fail,
  loadYaml,
  type CliContext,
  type CliDeps,
} from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { Result } from "../result.ts";
import type { SproutYaml } from "../yaml.ts";
import type { CiIdentity, CiPreviewIdentity } from "./ci-identity.ts";
import {
  applyDeployEnv,
  buildDeployRequest,
  postDeployAndWait,
  requireHealthWhenSeeding,
  type DeploySettled,
} from "./deploy-core.ts";
import { warnForgeNote } from "./forge-note.ts";
import { fetchPreviewLogs, parseTailFlag, printLogs } from "./logs.ts";

export const DEFAULT_CI_DEPLOY_TAIL = 200;

/** GitLab `artifacts:reports:dotenv` picks up `PREVIEW_URL` for `environment:url`. */
export const DEFAULT_CI_DEPLOY_DOTENV_FILE = "sprout-preview.env";

export type CiDeployPolicy = {
  allowReseed: boolean;
  prepareImages: (
    ctx: CliContext,
    yaml: SproutYaml,
    identity: CiPreviewIdentity,
  ) => Promise<Result<{ seedImage?: string }>>;
  beforeDeploy?: (
    client: ApiClient,
    identity: CiPreviewIdentity,
  ) => Promise<Result<unknown>>;
  publishNote: (
    deps: CliDeps,
    identity: CiIdentity,
    settled: DeploySettled & { reset?: boolean },
  ) => Promise<Result<void>>;
};

const BASE_DEPLOY_FLAGS = [
  "--app-env",
  "--app-env-file",
  "--seed-env",
  "--seed-env-file",
  "--seed-arg",
  "--service",
  "--clear-services",
  "--tail",
  "--dotenv-file",
] as const;

export async function runCiDeploy(
  identity: CiPreviewIdentity,
  tokens: string[],
  ctx: CliContext,
  policy: CiDeployPolicy,
): Promise<number> {
  const flags = parseFlags(tokens, policy.allowReseed
    ? [...BASE_DEPLOY_FLAGS, "--reseed"]
    : [...BASE_DEPLOY_FLAGS]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }

  const tail = parseTailFlag(flags.value.tail);
  if (!tail.ok) return fail(ctx.deps.io, tail.error);
  const tailN = tail.value ?? DEFAULT_CI_DEPLOY_TAIL;

  const dotenvRaw = flags.value.dotenvFile?.trim();
  const dotenvFile =
    dotenvRaw && dotenvRaw.length > 0
      ? dotenvRaw
      : DEFAULT_CI_DEPLOY_DOTENV_FILE;
  const dotenvPath = dotenvFile.startsWith("/")
    ? dotenvFile
    : `${ctx.deps.cwd}/${dotenvFile}`;

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  // None previews have no database to reseed; fail before any image work.
  if (
    yaml.value.db != null &&
    !requiresDatabase(yaml.value.db.provider) &&
    flags.value.reseed
  ) {
    return fail(ctx.deps.io, seedRequiresDatabaseMessage());
  }

  const seedBlock = yaml.value.seed;
  const seedGate = requireHealthWhenSeeding(yaml.value, {
    hasSeed: Boolean(seedBlock),
    seedSource: "seed",
  });
  if (!seedGate.ok) return fail(ctx.deps.io, seedGate.error);
  if (flags.value.reseed && !seedBlock) {
    return fail(ctx.deps.io, "--reseed requires a seed block in .sprout.yaml");
  }

  const images = await policy.prepareImages(ctx, yaml.value, identity);
  if (!images.ok) return fail(ctx.deps.io, images.error);
  const seedImage = images.value.seedImage;

  const assembled = buildDeployRequest(
    yaml.value,
    identity,
    seedImage
      ? {
          appImage: identity.imageRef,
          seedImage,
          seedSource: "seed",
          seedArg: flags.value.seedArg,
          service: flags.value.service,
          clearServices: flags.value.clearServices,
          reseed: flags.value.reseed,
        }
      : {
          appImage: identity.imageRef,
          seedArg: flags.value.seedArg,
          service: flags.value.service,
          clearServices: flags.value.clearServices,
          reseed: flags.value.reseed,
        },
  );
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

  if (policy.beforeDeploy) {
    const ready = await policy.beforeDeploy(ctx.client, identity);
    if (!ready.ok) return fail(ctx.deps.io, ready.error);
  }

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
  warnForgeNote(
    ctx.deps.io,
    await policy.publishNote(ctx.deps, identity, settled.value),
  );
  try {
    await write(dotenvPath, `PREVIEW_URL=${settled.value.previewUrl}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(ctx.deps.io, `cannot write dotenv file ${dotenvPath}: ${detail}`);
  }
  return 0;
}
