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

export type HealthProbe = {
  getStatus(url: string): Promise<number>;
};

export type HealthClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

const defaultClock: HealthClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Parse `"2s"` / `"120s"` style durations into milliseconds. */
export function parseDurationMs(raw: string): number | null {
  const match = /^(\d+)s$/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 1000;
}

export function resolveHealthSpec(
  input?: HealthRequest,
): { ok: true; value: HealthSpec } | { ok: false; error: string } {
  if (!input) return { ok: true, value: { ...DEFAULT_HEALTH } };

  const intervalMs = parseDurationMs(input.interval);
  if (intervalMs === null || intervalMs <= 0) {
    return { ok: false, error: "invalid_health_interval" };
  }
  const timeoutMs = parseDurationMs(input.timeout);
  if (timeoutMs === null || timeoutMs <= 0) {
    return { ok: false, error: "invalid_health_timeout" };
  }
  if (!Number.isInteger(input.expect) || input.expect < 100 || input.expect > 599) {
    return { ok: false, error: "invalid_health_expect" };
  }
  const path = input.path.trim();
  if (!path.startsWith("/")) {
    return { ok: false, error: "invalid_health_path" };
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

export function healthUrl(ip: string, port: number, path: string): string {
  return `http://${ip}:${port}${path}`;
}

/**
 * Poll until expectStatus or timeout.
 * `resolveUrl` may return null while the container has no IP yet — that counts
 * as not-ready and retries until the health timeout (same as a bad status).
 */
export async function pollHealth(
  probe: HealthProbe,
  resolveUrl: () => Promise<string | null>,
  spec: HealthSpec,
  clock: HealthClock = defaultClock,
): Promise<"ok" | "timeout"> {
  const deadline = clock.now() + spec.timeoutMs;

  for (;;) {
    const url = await resolveUrl();
    if (url) {
      try {
        const status = await probe.getStatus(url);
        if (status === spec.expectStatus) return "ok";
      } catch {
        // Container not listening yet — keep polling.
      }
    }
    if (clock.now() >= deadline) return "timeout";
    await clock.sleep(spec.intervalMs);
    if (clock.now() >= deadline) return "timeout";
  }
}

export function defaultHealthProbe(): HealthProbe {
  return {
    async getStatus(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return res.status;
    },
  };
}
