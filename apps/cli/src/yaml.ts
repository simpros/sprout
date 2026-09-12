import {
  parsePreviewEnvMap,
  resolveHealthSpec,
  validateHostnameValue,
  type HealthIssue,
  type PreviewEnvMap,
} from "@sprout/preview-env";
import { hostnameIssueMessage } from "./hostname.ts";
import type { Result } from "./result.ts";
import { SERVICE_NAME_RE } from "./service-name.ts";

export type { PreviewEnvMap };

export type SproutHealth = {
  path: string;
  interval: string;
  timeout: string;
  expect: number;
};

export type SproutYamlService = {
  name: string;
  /** Optional static image; usually supplied via `--service name=image`. */
  image?: string;
  /** Optional Host(); supports `{pr_id}` like preview.hostname. */
  hostname?: string;
  /** Optional PathPrefix (e.g. `/api`). */
  path?: string;
};

export type SproutYaml = {
  slug: string;
  preview: {
    hostname: string;
    env?: PreviewEnvMap;
    /** Static adopter env for the app container (secrets via --app-env / --app-env-file). */
    app_env?: Record<string, string>;
    /** Optional companion services (images usually via `--service`). */
    services?: SproutYamlService[];
  };
  health?: SproutHealth;
};

const TOP_KEYS = new Set(["slug", "preview", "health"]);
const PREVIEW_KEYS = new Set(["hostname", "env", "app_env", "services"]);
const HEALTH_KEYS = new Set(["path", "interval", "timeout", "expect"]);
const SERVICE_KEYS = new Set(["name", "image", "hostname", "path"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(path: string): Result<never> {
  return { ok: false, error: `unknown key: ${path}` };
}

function healthIssueMessage(label: string, issue: HealthIssue): string {
  switch (issue.code) {
    case "invalid_health_path":
      return `${label} must start with /`;
    case "invalid_health_interval":
    case "invalid_health_timeout":
      return `${label} is invalid (expected Ns, e.g. 2s)`;
    case "invalid_health_expect":
      return "health.expect must be a number between 100 and 599";
  }
}

function parseHostnameField(
  raw: string,
  label: string,
  mode: "required_template" | "static_or_template",
): Result<string> {
  const checked = validateHostnameValue(raw, mode);
  if (!checked.ok) {
    return { ok: false, error: hostnameIssueMessage(label, checked.issue) };
  }
  return { ok: true, value: raw };
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

/** Absent → undefined (leave). Empty list is rejected — use --clear-services. */
function parseServices(
  raw: unknown,
): Result<SproutYamlService[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "preview.services must be a list" };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      error:
        "preview.services: empty list; omit the key to leave companions, or pass --clear-services",
    };
  }

  const seen = new Set<string>();
  const out: SproutYamlService[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const path = `preview.services[${i}]`;
    if (!isPlainObject(entry)) {
      return { ok: false, error: `${path} must be a mapping` };
    }
    for (const key of Object.keys(entry)) {
      if (!SERVICE_KEYS.has(key)) return unknownKey(`${path}.${key}`);
    }
    const name = requireString(entry.name, `${path}.name`);
    if (!name.ok) return name;
    if (!SERVICE_NAME_RE.test(name.value)) {
      return { ok: false, error: `${path}.name is invalid` };
    }
    if (seen.has(name.value)) {
      return { ok: false, error: `preview.services: duplicate name: ${name.value}` };
    }
    seen.add(name.value);

    const service: SproutYamlService = { name: name.value };
    if (entry.image !== undefined) {
      const image = requireString(entry.image, `${path}.image`);
      if (!image.ok) return image;
      service.image = image.value;
    }
    if (entry.hostname !== undefined) {
      const hostname = requireString(entry.hostname, `${path}.hostname`);
      if (!hostname.ok) return hostname;
      const parsed = parseHostnameField(
        hostname.value,
        `${path}.hostname`,
        "static_or_template",
      );
      if (!parsed.ok) return parsed;
      service.hostname = parsed.value;
    }
    if (entry.path !== undefined) {
      const pathVal = requireString(entry.path, `${path}.path`);
      if (!pathVal.ok) return pathVal;
      if (!pathVal.value.startsWith("/")) {
        return { ok: false, error: `${path}.path must start with /` };
      }
      service.path = pathVal.value;
    }
    out.push(service);
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
  const template = parseHostnameField(
    hostname.value,
    "preview.hostname",
    "required_template",
  );
  if (!template.ok) return template;

  const env = parsePreviewEnv(parsed.preview.env);
  if (!env.ok) return env;

  const appEnv = parseAppEnv(parsed.preview.app_env);
  if (!appEnv.ok) return appEnv;

  const services = parseServices(parsed.preview.services);
  if (!services.ok) return services;

  const value: SproutYaml = {
    slug: slug.value,
    preview: { hostname: hostname.value },
  };
  if (env.value) value.preview.env = env.value;
  if (appEnv.value) value.preview.app_env = appEnv.value;
  if (services.value) value.preview.services = services.value;

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
      return {
        ok: false,
        error: "health.expect must be a number between 100 and 599",
      };
    }
    // Shared request-shape grammar (same as gateway resolveHealthSpec).
    const resolved = resolveHealthSpec({
      path: path.value,
      interval: interval.value,
      timeout: timeout.value,
      expect: parsed.health.expect,
    });
    if (!resolved.ok) {
      const { issue } = resolved;
      const label =
        issue.code === "invalid_health_path"
          ? "health.path"
          : issue.code === "invalid_health_interval"
            ? "health.interval"
            : issue.code === "invalid_health_timeout"
              ? "health.timeout"
              : "health.expect";
      return { ok: false, error: healthIssueMessage(label, issue) };
    }
    // Keep yaml wire strings; resolveHealthSpec already validated durations.
    value.health = {
      path: resolved.value.path,
      interval: interval.value.trim(),
      timeout: timeout.value.trim(),
      expect: parsed.health.expect,
    };
  }

  return { ok: true, value };
}
