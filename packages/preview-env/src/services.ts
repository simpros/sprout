import type { PreviewLabels } from "./labels.ts";

export const ENV_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SERVICE_PORT_MIN = 1;
export const SERVICE_PORT_MAX = 65535;

export type ServiceFields = {
  port?: number;
  env?: Record<string, string>;
  labels?: PreviewLabels;
};

export type PreviewServiceSpec = {
  name: string;
  image: string;
  hostname?: string;
  path?: string;
} & ServiceFields;

export function isServicePort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SERVICE_PORT_MIN &&
    value <= SERVICE_PORT_MAX
  );
}

export type ServiceEnvIssue =
  | { code: "not_a_mapping" }
  | { code: "empty_key" }
  | { code: "invalid_key"; key: string }
  | { code: "invalid_value"; key: string };

export function parseServiceEnvMap(
  raw: unknown,
):
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; issue: ServiceEnvIssue } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issue: { code: "not_a_mapping" } };
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: true, value: undefined };
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.trim() === "") {
      return { ok: false, issue: { code: "empty_key" } };
    }
    if (!ENV_TARGET_RE.test(key)) {
      return { ok: false, issue: { code: "invalid_key", key } };
    }
    if (typeof value !== "string") {
      return { ok: false, issue: { code: "invalid_value", key } };
    }
    out[key] = value;
  }
  return { ok: true, value: out };
}

export function copyServiceExtras(
  src: ServiceFields,
  dst: ServiceFields,
): void {
  if (src.port !== undefined) dst.port = src.port;
  if (src.env !== undefined) dst.env = { ...src.env };
  if (src.labels !== undefined) dst.labels = { ...src.labels };
}
