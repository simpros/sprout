import {
  parsePreviewEnvMap,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import type { Result } from "./result.ts";

export type { PreviewEnvMap };

export type SproutHealth = {
  path: string;
  interval: string;
  timeout: string;
  expect: number;
};

export type SproutYaml = {
  slug: string;
  preview: {
    hostname: string;
    env?: PreviewEnvMap;
    /** Static adopter env for the app container (secrets via --app-env / --app-env-file). */
    app_env?: Record<string, string>;
  };
  health?: SproutHealth;
};

const TOP_KEYS = new Set(["slug", "preview", "health"]);
const PREVIEW_KEYS = new Set(["hostname", "env", "app_env"]);
const HEALTH_KEYS = new Set(["path", "interval", "timeout", "expect"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(path: string): Result<never> {
  return { ok: false, error: `unknown key: ${path}` };
}

function requireString(
  value: unknown,
  label: string,
): Result<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${label} is required` };
  }
  return { ok: true, value: value.trim() };
}

/** Absent or empty map → undefined (no remapping). Path-aware CLI errors. */
function parsePreviewEnv(
  raw: unknown,
): Result<PreviewEnvMap | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, error: "preview.env must be a mapping" };
  }

  const parsed = parsePreviewEnvMap(raw);
  if (!parsed.ok) {
    const { issue } = parsed;
    switch (issue.code) {
      case "unknown_env_key":
        return unknownKey(`preview.env.${issue.key}`);
      case "empty_env_target":
        return { ok: false, error: `preview.env.${issue.key} is required` };
      case "invalid_env_target":
        return { ok: false, error: `preview.env.${issue.key} is invalid` };
      case "env_target_collision":
        return {
          ok: false,
          error: `preview.env: target collision: ${issue.target}`,
        };
    }
  }
  return { ok: true, value: parsed.value };
}

/** Absent or empty map → undefined. Values must be strings (no secret store). */
function parseAppEnv(
  raw: unknown,
): Result<Record<string, string> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, error: "preview.app_env must be a mapping" };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() === "") {
      return { ok: false, error: "preview.app_env key is required" };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `preview.app_env.${key} must be a string`,
      };
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: out };
}

export function parseSproutYaml(raw: string): Result<SproutYaml> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "invalid yaml",
    };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: "config must be a mapping" };
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_KEYS.has(key)) return unknownKey(key);
  }

  const slug = requireString(parsed.slug, "slug");
  if (!slug.ok) return slug;

  if (!isPlainObject(parsed.preview)) {
    return { ok: false, error: "preview is required" };
  }
  for (const key of Object.keys(parsed.preview)) {
    if (!PREVIEW_KEYS.has(key)) return unknownKey(`preview.${key}`);
  }
  const hostname = requireString(parsed.preview.hostname, "preview.hostname");
  if (!hostname.ok) return hostname;

  const env = parsePreviewEnv(parsed.preview.env);
  if (!env.ok) return env;

  const appEnv = parseAppEnv(parsed.preview.app_env);
  if (!appEnv.ok) return appEnv;

  const value: SproutYaml = {
    slug: slug.value,
    preview: { hostname: hostname.value },
  };
  if (env.value) value.preview.env = env.value;
  if (appEnv.value) value.preview.app_env = appEnv.value;

  if (parsed.health !== undefined) {
    if (!isPlainObject(parsed.health)) {
      return { ok: false, error: "health must be a mapping" };
    }
    for (const key of Object.keys(parsed.health)) {
      if (!HEALTH_KEYS.has(key)) return unknownKey(`health.${key}`);
    }
    const path = requireString(parsed.health.path, "health.path");
    if (!path.ok) return path;
    const interval = requireString(parsed.health.interval, "health.interval");
    if (!interval.ok) return interval;
    const timeout = requireString(parsed.health.timeout, "health.timeout");
    if (!timeout.ok) return timeout;
    if (typeof parsed.health.expect !== "number") {
      return { ok: false, error: "health.expect must be a number" };
    }
    value.health = {
      path: path.value,
      interval: interval.value,
      timeout: timeout.value,
      expect: parsed.health.expect,
    };
  }

  return { ok: true, value };
}
