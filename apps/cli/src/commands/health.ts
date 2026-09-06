import type { CliContext } from "../context.ts";
import { runJsonGet } from "../json-get.ts";

export async function runHealth(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  return runJsonGet(ctx, tokens, () => ctx.client.healthz.get());
}
