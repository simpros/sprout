import type { ApiClient } from "@sprout/api-client";
import type { CliContext } from "../context.ts";
import { fail, resolveIdentity } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import type { Result } from "../result.ts";

export type TeardownResponse = {
  ok: true;
  status: string;
};

export async function teardownPreview(
  client: ApiClient,
  identity: { repo: string; prId: number },
): Promise<Result<TeardownResponse>> {
  const response = await client.v1.teardown.post({
    canonical_repo_id: identity.repo,
    pr_id: identity.prId,
  });
  const result = readEden<TeardownResponse>(response);
  if (!result.ok) return { ok: false, error: result.message };
  return { ok: true, value: result.data };
}

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

  const result = await teardownPreview(ctx.client, identity.value);
  if (!result.ok) return fail(ctx.deps.io, result.error);
  return 0;
}
