import type { CliContext } from "../context.ts";
import { fail, loadYaml } from "../context.ts";
import { readEden } from "../eden.ts";
import { parseFlags } from "../flags.ts";
import { normalizeGitRemoteUrl } from "../identity.ts";

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
      return listTokens(rest, ctx);
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

async function listTokens(
  tokens: string[],
  ctx: CliContext,
): Promise<number> {
  const flags = parseFlags(tokens, []);
  if (!flags.ok) return fail(ctx.deps.io, flags.error);
  if (flags.value.rest.length > 0) {
    return fail(ctx.deps.io, "usage: sprout admin token list");
  }

  const response = await ctx.client.v1.admin.tokens.get();
  const result = readEden<unknown>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
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

  const rawRepo = flags.value.repo?.trim();
  if (!rawRepo) {
    return fail(ctx.deps.io, "--repo is required");
  }
  const repo = normalizeGitRemoteUrl(rawRepo);
  if (!repo) {
    return fail(ctx.deps.io, "invalid --repo URL");
  }

  let slug = flags.value.slug?.trim();
  if (!slug) {
    const yaml = await loadYaml(ctx.deps);
    if (!yaml.ok) {
      return fail(ctx.deps.io, "--slug is required (or provide .sprout.yaml)");
    }
    slug = yaml.value.slug;
  }

  const response = await ctx.client.v1.admin.tokens.post({
    canonical_repo_id: repo,
    slug,
  });
  const result = readEden<unknown>(response);
  if (!result.ok) return fail(ctx.deps.io, result.message);
  ctx.deps.io.stdout(JSON.stringify(result.data, null, 2));
  return 0;
}
