import { describe, expect, test } from "bun:test";
import { resolveServicesRequest } from "./deploy.ts";

describe("resolveServicesRequest", () => {
  test("absent services stay absent", () => {
    expect(resolveServicesRequest({})).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("passes port and env through", () => {
    expect(
      resolveServicesRequest({
        services: [
          {
            name: "api",
            image: "img:1",
            port: 4001,
            env: { API_KEY: "secret" },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "api",
          image: "img:1",
          port: 4001,
          env: { API_KEY: "secret" },
        },
      ],
    });
  });

  test("rejects out-of-range and non-integer ports", () => {
    for (const port of [0, 65536, 3.5, NaN]) {
      expect(
        resolveServicesRequest({
          services: [{ name: "api", image: "img:1", port }],
        }),
      ).toEqual({ ok: false, error: "invalid_service_port" });
    }
  });

  test("rejects malformed service env", () => {
    const badEnvs: unknown[] = ["PORT=1", { "bad-name": "x" }, { PORT: 8080 }];
    for (const env of badEnvs) {
      expect(
        resolveServicesRequest({
          services: [
            {
              name: "api",
              image: "img:1",
              env: env as Record<string, string>,
            },
          ],
        }),
      ).toEqual({ ok: false, error: "invalid_service_env" });
    }
  });

  test("empty env map is omitted", () => {
    expect(
      resolveServicesRequest({
        services: [{ name: "api", image: "img:1", env: {} }],
      }),
    ).toEqual({
      ok: true,
      value: [{ name: "api", image: "img:1" }],
    });
  });
});
