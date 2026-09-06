import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";

export async function runHealth(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, []);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      `unexpected arguments: ${flags.value.rest.join(" ")}`,
    );
  }

  const response = await ctx.client.healthz.get();
  const result = readEden<unknown>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data));
  return 0;
}
