import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { publishTeardownNote, warnForgeNote } from "./forge-note.ts";
import { teardownPreview } from "./teardown.ts";

/** Idempotent: the gateway reports `removed` when no preview exists. */
export async function runCiTeardown(
  identity: CiIdentity,
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

  const result = await teardownPreview(ctx.client, identity);
  if (!result.ok) return fail(ctx.deps.io, result.error);
  warnForgeNote(ctx.deps.io, await publishTeardownNote(ctx.deps, identity));
  return 0;
}
