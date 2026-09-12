import type { CliContext } from "../context.ts";
import { fail, loadEventPayload } from "../context.ts";
import { resolveCiIdentity } from "../identity.ts";

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

  const event = await loadEventPayload(ctx.deps);
  if (!event.ok) return fail(ctx.deps.io, event.error);

  const identity = resolveCiIdentity({
    env: ctx.deps.env,
    gitRemoteUrl: ctx.deps.getGitRemoteUrl(),
    eventPayload: event.value,
  });
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  // Identity is the #119 deliverable; subcommand bodies land in #120/#122.
  void identity.value;

  return fail(
    ctx.deps.io,
    `sprout ci ${subcommand} is not implemented yet`,
  );
}
