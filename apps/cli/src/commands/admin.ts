import type { CliContext } from "../context.ts";
import { fail, loadYaml, resolveRepo } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import { runJsonGet } from "../json-get.ts";

export async function runAdmin(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const [resource, action, ...rest] = tokens;
  if (resource !== "token") {
    return fail(
      ctx.deps.io,
      "usage: sprout admin token <create|revoke|list> …",
    );
  }

  switch (action) {
    case "list":
      return runJsonGet(ctx, rest, () => ctx.client.v1.admin.tokens.get());
    case "revoke":
      return revokeToken(rest, ctx);
    case "create":
      return createToken(rest, ctx);
    default:
      return fail(
        ctx.deps.io,
        "usage: sprout admin token <create|revoke|list> …",
      );
  }
}

async function revokeToken(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, []);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  const [id, ...more] = flags.value.rest;
  if (!id || more.length > 0) {
    return fail(ctx.deps.io, "usage: sprout admin token revoke <id>");
  }

  const response = await ctx.client.v1.admin.tokens({ id }).delete();
  const result = readEden<unknown>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}

async function createToken(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, ["--repo", "--slug", "--scope"]);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(
      ctx.deps.io,
      "usage: sprout admin token create --repo <url> [--slug <slug>] [--scope deploy]",
    );
  }
  if (flags.value.scope && flags.value.scope !== "deploy") {
    return fail(ctx.deps.io, "only --scope deploy is supported");
  }

  if (!flags.value.repo?.trim()) {
    return fail(ctx.deps.io, "--repo is required");
  }
  const repo = resolveRepo(ctx.deps, flags.value.repo);
  if (!repo.ok) return fail(ctx.deps.io, repo.error);

  let slug = flags.value.slug?.trim();
  if (!slug) {
    const yaml = await loadYaml(ctx.deps);
    if (!yaml.ok) {
      if (yaml.error.startsWith("missing ")) {
        return fail(
          ctx.deps.io,
          "--slug is required (or provide .sprout.yaml)",
        );
      }
      return fail(ctx.deps.io, yaml.error);
    }
    slug = yaml.value.slug;
  }

  const response = await ctx.client.v1.admin.tokens.post({
    canonical_repo_id: repo.value,
    slug,
  });
  const result = readEden<unknown>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}
