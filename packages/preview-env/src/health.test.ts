import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HEALTH,
  parseDurationMs,
  resolveHealthSpec,
} from "./health.ts";

describe("parseDurationMs", () => {
  test("parses second durations", () => {
    expect(parseDurationMs("2s")).toBe(2000);
    expect(parseDurationMs("120s")).toBe(120_000);
  });

  test("rejects non-second forms and non-positive", () => {
    expect(parseDurationMs("2")).toBeNull();
    expect(parseDurationMs("2ms")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("0s")).toBeNull();
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

  test("rejects bad path, duration, and expect", () => {
    expect(
      resolveHealthSpec({
        path: "health",
        interval: "2s",
        timeout: "120s",
        expect: 200,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_path" } });
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "2x",
        timeout: "120s",
        expect: 200,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_interval" } });
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "2s",
        timeout: "0s",
        expect: 200,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_timeout" } });
    expect(
      resolveHealthSpec({
        path: "/health",
        interval: "2s",
        timeout: "120s",
        expect: 99,
      }),
    ).toEqual({ ok: false, issue: { code: "invalid_health_expect" } });
  });
});
