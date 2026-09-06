import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HEALTH,
  healthUrl,
  parseDurationMs,
  pollHealth,
  resolveHealthSpec,
} from "./health.ts";

describe("parseDurationMs", () => {
  test("parses second durations", () => {
    expect(parseDurationMs("2s")).toBe(2000);
    expect(parseDurationMs("120s")).toBe(120_000);
  });

  test("rejects non-second forms", () => {
    expect(parseDurationMs("2")).toBeNull();
    expect(parseDurationMs("2ms")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
  });
});

describe("resolveHealthSpec", () => {
  test("defaults when omitted", () => {
    expect(resolveHealthSpec()).toEqual({
      ok: true,
      value: DEFAULT_HEALTH,
    });
  });

  test("honors yaml-shaped block", () => {
    expect(
      resolveHealthSpec({
        path: "/readyz",
        interval: "1s",
        timeout: "30s",
        expect: 204,
      }),
    ).toEqual({
      ok: true,
      value: {
        path: "/readyz",
        intervalMs: 1000,
        timeoutMs: 30_000,
        expectStatus: 204,
      },
    });
  });
});

describe("pollHealth", () => {
  test("returns ok on first matching status", async () => {
    const urls: string[] = [];
    const outcome = await pollHealth(
      {
        async getStatus(url) {
          urls.push(url);
          return 200;
        },
      },
      healthUrl("10.0.0.5", 8080, "/health"),
      DEFAULT_HEALTH,
    );
    expect(outcome).toBe("ok");
    expect(urls).toEqual(["http://10.0.0.5:8080/health"]);
  });

  test("times out when status never matches", async () => {
    let now = 0;
    const outcome = await pollHealth(
      {
        async getStatus() {
          return 503;
        },
      },
      "http://10.0.0.5:8080/health",
      { path: "/health", intervalMs: 1000, timeoutMs: 2500, expectStatus: 200 },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(outcome).toBe("timeout");
  });
});
