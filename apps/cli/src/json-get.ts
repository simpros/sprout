import type { CliContext } from "./context.ts";
import { fail } from "./context.ts";
import { readEden } from "./eden.ts";
import { parseFlags } from "./flags.ts";

/** Reject unexpected flags/positional args for no-flag GET commands. */
export function rejectUnexpectedArgs(tokens: string[]): string | null {
  const flags = parseFlags(tokens, []);
  if (!flags.ok) return flags.error;
  if (flags.value.rest.length > 0) {
    return `unexpected arguments: ${flags.value.rest.join(" ")}`;
  }
  return null;
}

/** Shared shape for health / list / admin token list. */
export async function runJsonGet(
  ctx: CliContext,
  tokens: string[],
  request: () => Promise<{ data: unknown; error: unknown; status?: number }>,
): Promise<number> {
  const bad = rejectUnexpectedArgs(tokens);
  if (bad) return fail(ctx.deps.io, bad);

  const result = readEden<unknown>(await request());
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}
