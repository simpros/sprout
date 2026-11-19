import type { CliContext } from "../context.ts";
import { fail } from "../context.ts";
import { parseFlags } from "../flags.ts";
import type { Result } from "../result.ts";
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

  const imagesPromise = resolveCiPushedImageRefs(ctx.deps, identity);
  const cleanupPromise = imagesPromise.then((images) =>
    cleanupPushedImageRefs(ctx.deps, identity, images.refs),
  );
  const notePromise = publishTeardownNote(ctx.deps, identity).catch(
    (err): Result<void> => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  let note: Result<void>;
  try {
    const [images, cleanup] = await Promise.all([imagesPromise, cleanupPromise]);
    for (const warning of images.warnings) {
      ctx.deps.io.stderr(`warning: ${warning}`);
    }
    for (const warning of cleanup.warnings) {
      ctx.deps.io.stderr(`warning: ${warning}`);
    }
    if (cleanup.deleted.length > 0) {
      ctx.deps.io.stdout(`deleted ${cleanup.deleted.length} registry tag(s)`);
    }
    note = await notePromise;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    ctx.deps.io.stderr(`warning: registry tag cleanup skipped: ${detail}`);
    note = await notePromise;
  }

  warnForgeNote(ctx.deps.io, note);
  return 0;
}
