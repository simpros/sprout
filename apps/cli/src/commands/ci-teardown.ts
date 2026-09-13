import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { CiIdentity } from "./ci-identity.ts";
import { publishTeardownNote, warnForgeNote } from "./forge-note.ts";
import { teardownPreview } from "./teardown.ts";

/**
 * `sprout ci teardown` — tear down this MR's preview through the gateway.
 * Idempotent: the gateway reports `removed` when no preview exists, so the
 * GitLab environment Stop button and MR-close pipelines both succeed.
 *
 * The MR note is rewritten in place ("preview was removed"), never deleted;
 * note failures only warn so gateway success owns the exit code.
 */
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
