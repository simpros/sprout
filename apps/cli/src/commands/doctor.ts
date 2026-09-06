import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { readEden } from "../eden.ts";
import { rejectUnexpectedArgs } from "../json-get.ts";

export async function runDoctor(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const bad = rejectUnexpectedArgs(tokens);
  if (bad) return fail(ctx.deps.io, bad);

  const response = await ctx.client.v1.doctor.get();
  const result = readEden<unknown>(response);
  if (!result.ok) {
    ctx.deps.io.stdout(JSON.stringify(result.body, null, 2));
    return fail(ctx.deps.io, result.message);
  }
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}
