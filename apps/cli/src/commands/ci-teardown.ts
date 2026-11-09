import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { parseFlags } from "../flags.ts";
import {
  resolveCiPushedImageRefs,
  type CiIdentity,
} from "./ci-identity.ts";
import { publishTeardownNote, warnForgeNote } from "./forge-note.ts";
import { cleanupPushedImageRefs } from "./image-cleanup.ts";
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

  try {
    const images = await resolveCiPushedImageRefs(ctx.deps, identity);
    for (const warning of images.warnings) {
      ctx.deps.io.stderr(`warning: ${warning}`);
    }
    const cleanup = await cleanupPushedImageRefs(
      ctx.deps,
      identity,
      images.refs,
    );
    for (const warning of cleanup.warnings) {
      ctx.deps.io.stderr(`warning: ${warning}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.deps.io.stderr(`warning: registry tag cleanup skipped: ${detail}`);
  }

  warnForgeNote(ctx.deps.io, await publishTeardownNote(ctx.deps, identity));
  return 0;
}
