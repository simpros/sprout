import { createHmac } from "node:crypto";
import type { Result } from "./result.ts";
import type { AppEnvValue } from "./yaml.ts";

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

export type AppEnvResolveContext = {
  hostname: string;
  prId: number;
  /** Present when CI exposes GITHUB_SHA / CI_COMMIT_SHA. */
  commitSha?: string;
  repo: string;
  /** Sprout deploy bearer (`SPROUT_TOKEN`); must stay stable for the MR lifetime. */
  deployToken?: string;
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
    switch (value.generate) {
      case "stable_per_pr": {
        const secret = stablePerPrSecret(key, ctx);
        if (!secret.ok) return secret;
        out[key] = secret.value;
        break;
      }
      default: {
        const _exhaustive: never = value.generate;
        return {
          ok: false,
          error: `preview.app_env.${key}: unknown generate kind: ${_exhaustive}`,
        };
      }
    }
  }
  return { ok: true, value: out };
}

function expandPlaceholders(
  key: string,
  template: string,
  ctx: AppEnvResolveContext,
): Result<string> {
  const values: Record<string, string | undefined> = {
    hostname: ctx.hostname,
    pr_id: String(ctx.prId),
    commit_sha: ctx.commitSha,
  };

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1]!;
    if (!(name in values)) {
      return {
        ok: false,
        error: `preview.app_env.${key}: unknown placeholder ${match[0]}`,
      };
    }
    if (values[name] === undefined) {
      if (name === "commit_sha") {
        return {
          ok: false,
          error: `preview.app_env.${key}: {commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA`,
        };
      }
      return {
        ok: false,
        error: `preview.app_env.${key}: {${name}} is not available`,
      };
    }
  }

  return {
    ok: true,
    value: template.replace(PLACEHOLDER_RE, (_m, name: string) => values[name]!),
  };
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
