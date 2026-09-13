/**
 * Preview health request-shape grammar (CLI yaml + gateway resolveHealthSpec).
 * Polling / probe runtime stays in the gateway.
 */

/** Resolved health poll settings (defaults when yaml/request omits the block). */
export type HealthSpec = {
  path: string;
  intervalMs: number;
  timeoutMs: number;
  expectStatus: number;
};

export const DEFAULT_HEALTH: HealthSpec = {
  path: "/health",
  intervalMs: 2_000,
  timeoutMs: 120_000,
  expectStatus: 200,
};

/** Wire shape of optional `health` on POST /v1/deploy (yaml-shaped durations). */
export type HealthRequest = {
  path: string;
  interval: string;
  timeout: string;
  expect: number;
};

export type HealthIssue =
  | { code: "invalid_health_interval" }
  | { code: "invalid_health_timeout" }
  | { code: "invalid_health_expect" }
  | { code: "invalid_health_path" };

/** Parse `"2s"` / `"120s"` style durations into milliseconds. */
export function parseDurationMs(raw: string): number | null {
  const match = /^(\d+)s$/.exec(raw.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  if (seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * Validate + resolve a yaml/HTTP health block into poll settings.
 * Absent input → {@link DEFAULT_HEALTH}.
 */
export function resolveHealthSpec(
  input?: HealthRequest,
):
  | { ok: true; value: HealthSpec }
  | { ok: false; issue: HealthIssue } {
  if (!input) return { ok: true, value: { ...DEFAULT_HEALTH } };

  const intervalMs = parseDurationMs(input.interval);
  if (intervalMs === null) {
    return { ok: false, issue: { code: "invalid_health_interval" } };
  }
  const timeoutMs = parseDurationMs(input.timeout);
  if (timeoutMs === null) {
    return { ok: false, issue: { code: "invalid_health_timeout" } };
  }
  if (!Number.isInteger(input.expect) || input.expect < 100 || input.expect > 599) {
    return { ok: false, issue: { code: "invalid_health_expect" } };
  }
  const path = input.path.trim();
  if (!path.startsWith("/")) {
    return { ok: false, issue: { code: "invalid_health_path" } };
  }

  return {
    ok: true,
    value: {
      path,
      intervalMs,
      timeoutMs,
      expectStatus: input.expect,
    },
  };
}
