import type { CliContext } from "../context.ts";
import { runJsonGet } from "../json-get.ts";

export async function runList(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  return runJsonGet(ctx, tokens, () => ctx.client.v1.previews.get());
}
