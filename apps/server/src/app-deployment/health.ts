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

/** Never throws: null URL, resolve/probe errors, and bad status all retry until timeout. */
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
    }
    if (url) {
      try {
        const status = await probe.getStatus(url);
        if (status === spec.expectStatus) return "ok";
      } catch {
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
