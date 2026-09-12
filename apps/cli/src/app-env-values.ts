import { createHmac } from "node:crypto";
import type { Result } from "./result.ts";
import type { AppEnvValue } from "./yaml.ts";

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;
const KNOWN_PLACEHOLDERS = new Set(["hostname", "pr_id", "commit_sha"]);

export type AppEnvResolveContext = {
  hostname: string;
  prId: number;
  /** Present when CI exposes GITHUB_SHA / CI_COMMIT_SHA. */
  commitSha?: string;
  repo: string;
  /** Sprout deploy bearer (`SPROUT_TOKEN`); must stay stable for the MR lifetime. */
  deployToken: string;
};

/**
 * Expand `preview.app_env` templates and materialize `generate: stable_per_pr`
 * secrets into plain strings for {@link mergeAppEnv}.
 */
export function resolveAppEnvValues(
  appEnv: Record<string, AppEnvValue> | undefined,
  ctx: AppEnvResolveContext,
): Result<Record<string, string> | undefined> {
  if (!appEnv || Object.keys(appEnv).length === 0) {
    return { ok: true, value: undefined };
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(appEnv)) {
    if (typeof value === "string") {
      const expanded = expandPlaceholders(key, value, ctx);
      if (!expanded.ok) return expanded;
      out[key] = expanded.value;
      continue;
    }
    const secret = stablePerPrSecret(key, ctx);
    if (!secret.ok) return secret;
    out[key] = secret.value;
  }
  return { ok: true, value: out };
}

function expandPlaceholders(
  key: string,
  template: string,
  ctx: AppEnvResolveContext,
): Result<string> {
  let unknown: string | undefined;
  let needsCommitSha = false;
  const replaced = template.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (!KNOWN_PLACEHOLDERS.has(name)) {
      unknown = match;
      return match;
    }
    if (name === "commit_sha") {
      needsCommitSha = true;
      return ctx.commitSha ?? match;
    }
    if (name === "hostname") return ctx.hostname;
    return String(ctx.prId);
  });
  if (unknown) {
    return {
      ok: false,
      error: `preview.app_env.${key}: unknown placeholder ${unknown}`,
    };
  }
  if (needsCommitSha && !ctx.commitSha) {
    return {
      ok: false,
      error: `preview.app_env.${key}: {commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA`,
    };
  }
  return { ok: true, value: replaced };
}

function stablePerPrSecret(
  envKey: string,
  ctx: AppEnvResolveContext,
): Result<string> {
  if (!ctx.deployToken) {
    return {
      ok: false,
      error: `preview.app_env.${envKey}: SPROUT_TOKEN required for generate: stable_per_pr`,
    };
  }
  const digest = createHmac("sha256", ctx.deployToken)
    .update(`sprout-stable-per-pr:${ctx.repo}:${ctx.prId}:${envKey}`)
    .digest("base64url");
  return { ok: true, value: digest };
}
