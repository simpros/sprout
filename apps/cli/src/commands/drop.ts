import type { CliContext } from "../context.ts";
import { fail, resolveRepo } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";

export async function runDrop(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, ["--yes", "--repo"]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);

  const [prRaw, ...extra] = flags.value.rest;
  if (!prRaw || extra.length > 0) {
    return fail(ctx.deps.io, "usage: sprout drop <pr_id> [--yes]");
  }
  const prId = Number(prRaw);
  if (!Number.isInteger(prId) || prId <= 0) {
    return fail(ctx.deps.io, "pr_id must be a positive integer");
  }

  const repo = resolveRepo(ctx.deps, flags.value.repo);
  if (!repo.ok) return fail(ctx.deps.io, repo.error);

  const response = await ctx.client.v1.drop.post({
    canonical_repo_id: repo.value,
    pr_id: prId,
    yes: flags.value.yes || undefined,
  });

  const result = readEden<unknown>(response);
  if (result.status === 409) {
    const body = result.ok
      ? result.data
      : (result.body ?? { error: "confirmation_required" });
    ctx.deps.io.stdout(JSON.stringify(body, null, 2));
    return fail(ctx.deps.io, "confirmation required; re-run with --yes", 2);
  }
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}
