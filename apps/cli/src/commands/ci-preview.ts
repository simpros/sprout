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
import { publishPreviewNote, warnForgeNote } from "./forge-note.ts";
import { buildAndPush } from "./image-build.ts";
import { ensureSeedImage } from "./seed-image.ts";

/** Log lines dumped from the gateway on a failed deploy. */
export const DEFAULT_CI_PREVIEW_TAIL = 200;

/**
 * Default dotenv artifact (relative to the workspace root): GitLab
 * `artifacts:reports:dotenv` picks up `PREVIEW_URL` for `environment:url`.
 */
export const DEFAULT_PREVIEW_DOTENV_FILE = "sprout-preview.env";

/**
 * `sprout ci preview` — build + push the app image (and the seed image when
 * `.sprout.yaml` configures `seed`: always rebuilt without `seed.inputs`,
 * reused by content-addressed tag with them), deploy with the resolved env, and on a healthy
 * preview emit `preview_url=` plus the dotenv artifact. On failure the
 * gateway log tail is printed first, then the deploy error exits non-zero.
 * Settling reuses `postDeployAndWait` — there is no second deploy
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
    "--reseed",
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
  const seedBlock = yaml.value.seed;
  // Intentional preflight: fail before docker build/push. The assembler
  // re-checks the same gate (keyed off the resolved seed image) as the
  // canonical owner; service-flag validation lives there too. A present
  // seed block always carries a dockerfile (the parser defaults it), so
  // presence alone gates seeding.
  const seedGate = requireHealthWhenSeeding(yaml.value, {
    hasSeed: Boolean(seedBlock),
    seedSource: "seed",
  });
  if (!seedGate.ok) return fail(ctx.deps.io, seedGate.error);
  if (flags.value.reseed && !seedBlock) {
    return fail(ctx.deps.io, "--reseed requires a seed block in .sprout.yaml");
  }

  // Seed first: unreadable inputs fail before any docker work, and the
  // seed tag derives from the app ref without needing the app built.
  let seedImage: string | undefined;
  if (seedBlock) {
    const seed = await ensureSeedImage(ctx, seedBlock, identity.imageRef);
    if (!seed.ok) return fail(ctx.deps.io, seed.error);
    seedImage = seed.value.ref;
  }

  const app = await buildAndPush(ctx, "app", appDockerfile, identity.imageRef);
  if (!app.ok) return fail(ctx.deps.io, app.error);

  const previewInputs: BuildDeployRequestInputs = seedImage
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
      };
  const assembled = buildDeployRequest(yaml.value, identity, previewInputs);
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
  // The MR note is best-effort: gateway success owns the exit code, forge
  // failures only warn (with the forge's error body, never the token).
  warnForgeNote(ctx.deps.io, await publishPreviewNote(ctx.deps, identity, settled.value));
  try {
    await write(dotenvPath, `PREVIEW_URL=${settled.value}\n`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(ctx.deps.io, `cannot write dotenv file ${dotenvPath}: ${detail}`);
  }
  return 0;
}
