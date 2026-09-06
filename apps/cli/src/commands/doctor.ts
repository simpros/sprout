import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";

type DoctorBody = {
  ok?: boolean;
  error?: string;
};

export async function runDoctor(
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

  const response = await ctx.client.v1.doctor.get();
  const result = readEden<DoctorBody>(response);
  if (!result.ok) {
    const body = (result.body ?? {}) as DoctorBody;
    ctx.deps.io.stdout(JSON.stringify(result.body ?? response.error, null, 2));
    return fail(ctx.deps.io, body.error ?? result.message);
  }
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}
