import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import {
  type CiIdentity,
  resolveCiIdentity,
} from "./ci-identity.ts";

const CI_HELP = `usage: sprout ci <preview|teardown|reseed|logs> …

CI command group — infers repo, PR/MR id, and image ref from the pipeline env.

  preview   Build, push, and deploy a preview for this merge request
  teardown  Tear down the preview for this merge request
  reseed    Re-run the seed job against the existing preview database
  logs      Print preview container logs from the gateway
`;

const SUBCOMMANDS = new Set(["preview", "teardown", "reseed", "logs"]);

function printHelp(ctx: CliContext): number {
  ctx.deps.io.stdout(CI_HELP.trimEnd());
  return 0;
}

/** #120/#122 hang off this seam; identity is resolved once for the group. */
function dispatchCiSubcommand(
  subcommand: string,
  _identity: CiIdentity,
  ctx: CliContext,
): number {
  return fail(
    ctx.deps.io,
    `sprout ci ${subcommand} is not implemented yet`,
  );
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

  const identity = await resolveCiIdentity(ctx.deps);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  return dispatchCiSubcommand(subcommand, identity.value, ctx);
}
