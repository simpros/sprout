/**
 * Gateway health polling. Request-shape grammar lives in `@sprout/preview-env`.
 */

import type { HealthSpec } from "@sprout/preview-env";

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

export function healthUrl(ip: string, port: number, path: string): string {
  return `http://${ip}:${port}${path}`;
}

/**
 * Poll until expectStatus or timeout. Total: never throws.
 * `resolveUrl` may return null (no IP yet) or throw (transient inspect blip) —
 * both count as not-ready and retry until the health timeout (same as a bad status).
 */
export async function pollHealth(
  probe: HealthProbe,
  resolveUrl: () => Promise<string | null>,
  spec: HealthSpec,
  clock: HealthClock = defaultClock,
): Promise<"ok" | "timeout"> {
  const deadline = clock.now() + spec.timeoutMs;

  for (;;) {
    let url: string | null = null;
    try {
      url = await resolveUrl();
    } catch {
      // Docker inspect blip / network race — keep polling.
    }
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
