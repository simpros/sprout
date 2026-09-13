import type { CliContext } from "../context.ts";
import { authedClient, fail } from "../context.ts";
import {
  resolveCiIdentity,
  resolveCiPreviewIdentity,
  type CiIdentity,
  type CiPreviewIdentity,
} from "./ci-identity.ts";
import { runCiLogs } from "./ci-logs.ts";
import { runCiPreview } from "./ci-preview.ts";
import { runCiReseed } from "./ci-reseed.ts";
import { runCiTeardown } from "./ci-teardown.ts";

const CI_HELP = `usage: sprout ci <preview|teardown|reseed|logs> …

CI command group — infers repo, PR/MR id, and pipeline source from the CI env.

  preview   Build, push, and deploy a preview for this merge request:
            sprout ci preview [--tail N] [--dotenv-file PATH]
              [--app-env K=V …] [--seed-env K=V …] [--seed-arg …]
  teardown  Tear down the preview for this merge request
  reseed    Re-run the seed job against the existing preview database:
            sprout ci reseed -s <seed-image> [--seed-env K=V …] [--seed-arg …]
  logs      Print preview container logs from the gateway:
            sprout ci logs [--tail N]
`;

type CiSubcommand = "preview" | "teardown" | "reseed" | "logs";

function parseCiSubcommand(token: string): CiSubcommand | null {
  switch (token) {
    case "preview":
    case "teardown":
    case "reseed":
    case "logs":
      return token;
    default:
      return null;
  }
}

function printHelp(ctx: CliContext): number {
  ctx.deps.io.stdout(CI_HELP.trimEnd());
  return 0;
}

/**
 * CI group: resolve identity before auth so outside-pipeline errors win over
 * missing-token. After identity succeeds, auth once and pass a real client.
 */
export async function runCi(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const [subcommandToken = "", ...rest] = tokens;
  if (
    !subcommandToken ||
    subcommandToken === "--help" ||
    subcommandToken === "-h"
  ) {
    return printHelp(ctx);
  }

  const subcommand = parseCiSubcommand(subcommandToken);
  if (!subcommand) {
    return fail(ctx.deps.io, CI_HELP.trimEnd());
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    return printHelp(ctx);
  }

  // Identity resolves before auth so outside-pipeline errors win over
  // missing-token. The token resolves once here and the authed client is
  // handed down — subcommands never touch token env vars themselves.
  let identity: CiIdentity;
  let previewIdentity: CiPreviewIdentity | undefined;
  if (subcommand === "preview") {
    const preview = await resolveCiPreviewIdentity(ctx.deps);
    if (!preview.ok) return fail(ctx.deps.io, preview.error);
    previewIdentity = preview.value;
    identity = preview.value;
  } else {
    const base = await resolveCiIdentity(ctx.deps);
    if (!base.ok) return fail(ctx.deps.io, base.error);
    identity = base.value;
  }

  const client = await authedClient(ctx.deps);
  if (!client.ok) return fail(ctx.deps.io, client.error);

  const subCtx = { deps: ctx.deps, client: client.value };
  switch (subcommand) {
    case "preview":
      return runCiPreview(
        previewIdentity as CiPreviewIdentity,
        rest,
        subCtx,
      );
    case "teardown":
      return runCiTeardown(identity, rest, subCtx);
    case "reseed":
      return runCiReseed(identity, rest, subCtx);
    case "logs":
      return runCiLogs(identity, rest, subCtx);
  }
}
