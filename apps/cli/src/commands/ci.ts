import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import {
  resolveCiIdentity,
  resolveCiPreviewIdentity,
} from "./ci-identity.ts";

const CI_HELP = `usage: sprout ci <preview|teardown|reseed|logs> …

CI command group — infers repo, PR/MR id, and pipeline source from the CI env.

  preview   Build, push, and deploy a preview for this merge request (also image ref + hostname)
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

  if (subcommand === "preview") {
    const identity = await resolveCiPreviewIdentity(ctx.deps);
    if (!identity.ok) return fail(ctx.deps.io, identity.error);
    // #120: runCiPreview(identity.value, ctx)
    return fail(ctx.deps.io, "sprout ci preview is not implemented yet");
  }

  const identity = await resolveCiIdentity(ctx.deps);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);
  // #122: runCiTeardown / reseed / logs(identity.value, ctx)
  return fail(ctx.deps.io, `sprout ci ${subcommand} is not implemented yet`);
}
