import type { CliContext } from "../context.ts";
import { authedClient, fail } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { formatLogs, type LogsResponse } from "./logs.ts";

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

  let tail: number | undefined;
  if (flags.value.tail !== undefined) {
    const n = Number(flags.value.tail);
    if (!Number.isInteger(n) || n < 1) {
      return fail(ctx.deps.io, "--tail must be a positive integer");
    }
    tail = n;
  }

  const client = await authedClient(ctx.deps);
  if (!client.ok) return fail(ctx.deps.io, client.error);

  const response = await client.value.v1
    .previews({ id: String(identity.prId) })
    .logs.get({
      query: {
        canonical_repo_id: identity.repo,
        ...(tail !== undefined ? { tail: String(tail) } : {}),
      },
    });

  const result = readEden<LogsResponse>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);

  ctx.deps.io.stdout(formatLogs(result.data).replace(/\n$/, ""));
  return 0;
}
