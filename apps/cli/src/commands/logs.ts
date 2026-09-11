import type { CliContext } from "../context.ts";
import { fail, resolveRepo } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";

type LogsResponse = {
  ok: true;
  canonical_repo_id: string;
  pr_id: number;
  tail: number;
  app: string;
  seed: string;
};

function formatLogs(data: LogsResponse): string {
  const sections = [`=== app ===\n${data.app.replace(/\n$/, "")}`];
  if (data.seed !== "") {
    sections.push(`=== seed ===\n${data.seed.replace(/\n$/, "")}`);
  }
  return `${sections.join("\n")}\n`;
}

export async function runLogs(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, ["--repo", "--tail"]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);

  const [prRaw, ...extra] = flags.value.rest;
  if (!prRaw || extra.length > 0) {
    return fail(
      ctx.deps.io,
      "usage: sprout logs <pr_id> [--tail N] [--repo URL]",
    );
  }
  const prId = Number(prRaw);
  if (!Number.isInteger(prId) || prId <= 0) {
    return fail(ctx.deps.io, "pr_id must be a positive integer");
  }

  let tail: number | undefined;
  if (flags.value.tail !== undefined) {
    const n = Number(flags.value.tail);
    if (!Number.isInteger(n) || n < 1) {
      return fail(ctx.deps.io, "--tail must be a positive integer");
    }
    tail = n;
  }

  const repo = resolveRepo(ctx.deps, flags.value.repo);
  if (!repo.ok) return fail(ctx.deps.io, repo.error);

  const response = await ctx.client.v1
    .previews({ id: String(prId) })
    .logs.get({
      query: {
        canonical_repo_id: repo.value,
        ...(tail !== undefined ? { tail: String(tail) } : {}),
      },
    });

  const result = readEden<LogsResponse>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);

  ctx.deps.io.stdout(formatLogs(result.data).replace(/\n$/, ""));
  return 0;
}
