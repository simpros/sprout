import { createHmac } from "node:crypto";
import { expandBracedPlaceholders } from "./placeholders.ts";
import type { Result } from "./result.ts";
import type { AppEnvValue } from "./yaml.ts";

const PLACEHOLDERS: Record<
  string,
  (ctx: AppEnvResolveContext) => string | undefined
> = {
  hostname: (c) => c.hostname,
  pr_id: (c) => String(c.prId),
  commit_sha: (c) => c.commitSha,
};

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
  const values: Record<string, string | undefined> = {};
  for (const [name, resolve] of Object.entries(PLACEHOLDERS)) {
    values[name] = resolve(ctx);
  }
  const expanded = expandBracedPlaceholders(template, values, {
    unknown: "error",
  });
  if (!expanded.ok) {
    if (expanded.failure.kind === "unknown") {
      return {
        ok: false,
        error: `preview.app_env.${key}: unknown placeholder ${expanded.failure.match}`,
      };
    }
    return {
      ok: false,
      error: `preview.app_env.${key}: {${expanded.failure.name}} requires GITHUB_SHA or CI_COMMIT_SHA`,
    };
  }
  return { ok: true, value: expanded.value };
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
