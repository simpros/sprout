import type { CliContext } from "../context.ts";
import { authedClient, fail } from "../context.ts";
import {
  type CiIdentity,
  resolveCiIdentity,
  resolveCiPreviewIdentity,
} from "./ci-identity.ts";
import { runCiLogs } from "./ci-logs.ts";
import { runCiReseed } from "./ci-reseed.ts";
import { runCiTeardown } from "./ci-teardown.ts";

const CI_HELP = `usage: sprout ci <preview|teardown|reseed|logs> …

CI command group — infers repo, PR/MR id, and pipeline source from the CI env.

  preview   Build, push, and deploy a preview for this merge request (also image ref + hostname)
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

/**
 * CI group: resolve identity before auth so outside-pipeline errors win over
 * missing-token. After identity succeeds, auth once and pass a real client.
 */
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

  // `preview` lands in #120: resolve its identity, then fail directly
  // without auth or the real dispatcher so the stub never fake-dispatches.
  if (subcommand === "preview") {
    const previewIdentity = await resolveCiPreviewIdentity(ctx.deps);
    if (!previewIdentity.ok) return fail(ctx.deps.io, previewIdentity.error);
    return fail(ctx.deps.io, "sprout ci preview is not implemented yet");
  }

  const identity = await resolveCiIdentity(ctx.deps);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  const client = await authedClient(ctx.deps);
  if (!client.ok) return fail(ctx.deps.io, client.error);

  return dispatchCiSubcommand(subcommand, identity.value, rest, {
    deps: ctx.deps,
    client: client.value,
  });
}
