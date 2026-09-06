import type { CliContext } from "../context.ts";
import { fail, resolveIdentity } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";

export async function runTeardown(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, ["--repo"]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }

  const identity = await resolveIdentity(ctx.deps, flags.value.repo);
  if (!identity.ok) return fail(ctx.deps.io, identity.error);

  const response = await ctx.client.v1.teardown.post({
    canonical_repo_id: identity.value.repo,
    pr_id: identity.value.prId,
  });
  const result = readEden<unknown>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);
  return 0;
}
