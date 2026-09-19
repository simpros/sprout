import type { CliContext } from "../context.ts";
import {
  defaultWriteTextFile,
  fail,
  loadYaml,
} from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { CiPreviewIdentity } from "./ci-identity.ts";
import {
  applyDeployEnv,
  buildDeployRequest,
  postDeployAndWait,
  requireHealthWhenSeeding,
  type BuildDeployRequestInputs,
} from "./deploy-core.ts";
import { fetchPreviewLogs, parseTailFlag, printLogs } from "./logs.ts";
import { publishResetNote, warnForgeNote } from "./forge-note.ts";
import { resolveSeedTarget } from "./seed-image.ts";
import { teardownPreview } from "./teardown.ts";

export const DEFAULT_CI_RESET_TAIL = 200;

export const DEFAULT_RESET_DOTENV_FILE = "sprout-preview.env";

export async function runCiReset(
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

  const tail = parseTailFlag(flags.value.tail);
  if (!tail.ok) return fail(ctx.deps.io, tail.error);
  const tailN = tail.value ?? DEFAULT_CI_RESET_TAIL;

  const dotenvRaw = flags.value.dotenvFile?.trim();
  const dotenvFile =
    dotenvRaw && dotenvRaw.length > 0 ? dotenvRaw : DEFAULT_RESET_DOTENV_FILE;
  const dotenvPath = dotenvFile.startsWith("/")
    ? dotenvFile
    : `${ctx.deps.cwd}/${dotenvFile}`;

  const yaml = await loadYaml(ctx.deps);
  if (!yaml.ok) return fail(ctx.deps.io, yaml.error);

  const seedBlock = yaml.value.seed;
  const seedGate = requireHealthWhenSeeding(yaml.value, {
    hasSeed: Boolean(seedBlock),
    seedSource: "seed",
  });
  if (!seedGate.ok) return fail(ctx.deps.io, seedGate.error);

  let seedImage: string | undefined;
  if (seedBlock) {
    const target = await resolveSeedTarget(
      seedBlock,
      identity.imageRef,
      ctx.deps.cwd,
      ctx.deps.readTextFile,
    );
    if (!target.ok) return fail(ctx.deps.io, target.error);
    seedImage = target.value.ref;
  }

  const resetInputs: BuildDeployRequestInputs = seedImage
    ? {
        appImage: identity.imageRef,
        seedImage,
        seedSource: "seed",
        seedArg: flags.value.seedArg,
        service: flags.value.service,
        clearServices: flags.value.clearServices,
      }
    : {
        appImage: identity.imageRef,
        seedArg: flags.value.seedArg,
        service: flags.value.service,
        clearServices: flags.value.clearServices,
      };
  const assembled = buildDeployRequest(yaml.value, identity, resetInputs);
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

  const torn = await teardownPreview(ctx.client, identity);
  if (!torn.ok) return fail(ctx.deps.io, torn.error);

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
  warnForgeNote(ctx.deps.io, await publishResetNote(ctx.deps, identity, settled.value));
  try {
    await write(dotenvPath, `PREVIEW_URL=${settled.value}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(ctx.deps.io, `cannot write dotenv file ${dotenvPath}: ${detail}`);
  }
  return 0;
}
