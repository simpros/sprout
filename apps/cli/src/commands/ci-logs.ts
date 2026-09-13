import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { fetchPreviewLogs, parseTailFlag, printLogs } from "./logs.ts";

/**
 * `sprout ci logs [--tail N]` — preview container logs through the gateway.
 * Identity comes from CI env only; no `--repo`/`--pr` flags exist here.
 */
export async function runCiLogs(
  identity: CiIdentity,
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, ["--tail"]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(ctx.deps.io, "usage: sprout ci logs [--tail N]");
  }

  const tail = parseTailFlag(flags.value.tail);
  if (!tail.ok) return fail(ctx.deps.io, tail.error);

  const logs = await fetchPreviewLogs(ctx.client, {
    repo: identity.repo,
    prId: identity.prId,
    tail: tail.value,
  });
  if (!logs.ok) return fail(ctx.deps.io, logs.error);

  printLogs(ctx.deps.io, logs.value);
  return 0;
}
