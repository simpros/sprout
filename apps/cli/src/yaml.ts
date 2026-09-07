import type { Result } from "./result.ts";

export type SproutHealth = {
  path: string;
  interval: string;
  timeout: string;
  expect: number;
};

const CANONICAL_ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

type CanonicalEnvKey = (typeof CANONICAL_ENV_KEYS)[number];

/** Partial remap of canonical connection env names → adopter names. */
export type PreviewEnvMap = Partial<Record<CanonicalEnvKey, string>>;

export type SproutYaml = {
  slug: string;
  preview: { hostname: string; env?: PreviewEnvMap };
  health?: SproutHealth;
};

const TOP_KEYS = new Set(["slug", "preview", "health"]);
const PREVIEW_KEYS = new Set(["hostname", "env"]);
const HEALTH_KEYS = new Set(["path", "interval", "timeout", "expect"]);
const CANONICAL_ENV_KEY_SET = new Set<string>(CANONICAL_ENV_KEYS);
const ENV_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/** Absent or empty map → undefined (no remapping). */
function parsePreviewEnv(
  raw: unknown,
): Result<PreviewEnvMap | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return { ok: false, error: "preview.env must be a mapping" };
  }

  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: true, value: undefined };

  const env: PreviewEnvMap = {};
  const seenTargets = new Map<string, string>();

  for (const [key, value] of entries) {
    if (!CANONICAL_ENV_KEY_SET.has(key)) {
      return unknownKey(`preview.env.${key}`);
    }
    const target = requireString(value, `preview.env.${key}`);
    if (!target.ok) return target;
    if (!ENV_TARGET_RE.test(target.value)) {
      return {
        ok: false,
        error: `preview.env.${key} is invalid`,
      };
    }
    const prior = seenTargets.get(target.value);
    if (prior !== undefined) {
      return {
        ok: false,
        error: `preview.env: target collision: ${target.value}`,
      };
    }
    seenTargets.set(target.value, key);
    env[key as CanonicalEnvKey] = target.value;
  }

  return { ok: true, value: env };
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
