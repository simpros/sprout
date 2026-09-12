import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import {
  type CiIdentity,
  resolveCiIdentity,
  resolveCiPreviewIdentity,
} from "./ci-identity.ts";
import { runCiLogs } from "./ci-logs.ts";
import { runCiReseed } from "./ci-reseed.ts";
import { runCiTeardown } from "./ci-teardown.ts";

const CI_HELP = `usage: sprout ci <preview|teardown|reseed|logs> …

CI command group — infers repo, PR/MR id, and image ref from the pipeline env.

  preview   Build, push, and deploy a preview for this merge request
  teardown  Tear down the preview for this merge request
  reseed    Re-run the seed job against the existing preview database:
            sprout ci reseed -s <seed-image> [--seed-env K=V …] [--seed-arg …]
  logs      Print preview container logs from the gateway:
            sprout ci logs [--tail N]
`;

const SUBCOMMANDS = new Set(["preview", "teardown", "reseed", "logs"]);

function printHelp(ctx: CliContext): number {
  ctx.deps.io.stdout(CI_HELP.trimEnd());
  return 0;
}

/** `preview` lands in #120; teardown/reseed/logs are implemented. */
async function dispatchCiSubcommand(
  subcommand: string,
  identity: CiIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  switch (subcommand) {
    case "teardown":
      return runCiTeardown(identity, tokens, ctx);
    case "reseed":
      return runCiReseed(identity, tokens, ctx);
    case "logs":
      return runCiLogs(identity, tokens, ctx);
    default:
      return fail(
        ctx.deps.io,
        `sprout ci ${subcommand} is not implemented yet`,
      );
  }
}

export async function runCi(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const [subcommand = "", ...rest] = tokens;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return printHelp(ctx);
  }

  if (!SUBCOMMANDS.has(subcommand)) {
    return fail(ctx.deps.io, CI_HELP.trimEnd());
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    return printHelp(ctx);
  }

  if (subcommand === "preview") {
    const identity = await resolveCiPreviewIdentity(ctx.deps);
    if (!identity.ok) return fail(ctx.deps.io, identity.error);
    return dispatchCiSubcommand(subcommand, identity.value, rest, ctx);
  }

  const identity = await resolveCiIdentity(ctx.deps);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  return dispatchCiSubcommand(subcommand, identity.value, rest, ctx);
}
