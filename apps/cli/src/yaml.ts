import {
  validatePreviewEnvMap,
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
  preview: { hostname: string; env?: PreviewEnvMap };
  health?: SproutHealth;
};

const TOP_KEYS = new Set(["slug", "preview", "health"]);
const PREVIEW_KEYS = new Set(["hostname", "env"]);
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

  const env = validatePreviewEnvMap(parsed.preview.env, "preview.env");
  if (!env.ok) return env;

  const value: SproutYaml = {
    slug: slug.value,
    preview: { hostname: hostname.value },
  };
  if (env.value) value.preview.env = env.value;

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
