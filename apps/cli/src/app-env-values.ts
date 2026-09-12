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

/** Keys declared `{ required: true }` in the manifest, in declaration order. */
export function requiredAppEnvKeys(
  appEnv: Record<string, AppEnvValue> | undefined,
): string[] {
  if (!appEnv) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(appEnv)) {
    if (typeof value === "object" && value !== null && "required" in value) {
      out.push(key);
    }
  }
  return out;
}

/**
 * Expand `{hostname}` / `{pr_id}` / `{commit_sha}` in one value. The error is a
 * bare reason with no key prefix so `--app-env-file` and `--app-env` callers
 * can label the source; `resolveAppEnvValues` adds the manifest key.
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
 * Expand `preview.app_env` templates and materialize `generate: stable_per_pr`
 * secrets into plain strings for {@link mergeAppEnv}. `{ required: true }`
 * entries contribute no value here — they are enforced after CI layers merge.
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
      const expanded = expandAppEnvValue(value, ctx);
      if (!expanded.ok) {
        return { ok: false, error: `preview.app_env.${key}: ${expanded.error}` };
      }
      out[key] = expanded.value;
      continue;
    }
    if ("required" in value) continue;
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
  if (Object.keys(out).length === 0) return { ok: true, value: undefined };
  return { ok: true, value: out };
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
