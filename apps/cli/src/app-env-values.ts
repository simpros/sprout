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
  deployToken?: string;
};

/** Manifest layer for {@link mergeAppEnv}: templates unexpanded, generates materialized. */
export type ResolvedAppEnv = {
  values: Record<string, string> | undefined;
  requiredKeys: string[];
};

/**
 * Expand `{hostname}` / `{pr_id}` / `{commit_sha}` in one value. The error is a
 * bare reason with no key prefix so merge can label with the final key.
 */
export function expandAppEnvValue(
  value: string,
  ctx: AppEnvResolveContext,
): Result<string> {
  let unknown: string | undefined;
  let needsCommitSha = false;
  const replaced = value.replace(PLACEHOLDER_RE, (match, name: string) => {
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
    return { ok: false, error: `unknown placeholder ${unknown}` };
  }
  if (needsCommitSha && !ctx.commitSha) {
    return {
      ok: false,
      error: "{commit_sha} requires GITHUB_SHA or CI_COMMIT_SHA",
    };
  }
  return { ok: true, value: replaced };
}

/**
 * Materialize `generate: stable_per_pr` secrets and collect `{ required: true }`
 * keys. String templates pass through **unexpanded** — {@link mergeAppEnv}
 * expands each final value once after CI layers merge.
 */
export function resolveAppEnvValues(
  appEnv: Record<string, AppEnvValue> | undefined,
  ctx: AppEnvResolveContext,
): Result<ResolvedAppEnv> {
  if (!appEnv || Object.keys(appEnv).length === 0) {
    return { ok: true, value: { values: undefined, requiredKeys: [] } };
  }

  const out: Record<string, string> = {};
  const requiredKeys: string[] = [];
  for (const [key, value] of Object.entries(appEnv)) {
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    if ("generate" in value) {
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
      continue;
    }
    if (value.required === true) {
      requiredKeys.push(key);
    }
  }
  return {
    ok: true,
    value: {
      values: Object.keys(out).length === 0 ? undefined : out,
      requiredKeys,
    },
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
