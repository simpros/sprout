import { describe, expect, test } from "bun:test";
import { resolveLabelCollisions } from "../app-deployment/label-collisions.ts";
import {
  resolvePreviewLabelsRequest,
  resolveServicesRequest,
} from "./deploy.ts";

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

  test("passes service labels through", () => {
    expect(
      resolveServicesRequest({
        services: [
          {
            name: "api",
            image: "img:1",
            labels: { "com.example.backup": "true" },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "api",
          image: "img:1",
          labels: { "com.example.backup": "true" },
        },
      ],
    });
  });

  test("rejects malformed service labels with the manifest path", () => {
    expect(
      resolveServicesRequest({
        services: [
          { name: "api", image: "img:1", labels: { "bad key": "x" } },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "invalid_service_labels",
      detail: "preview.services[0].labels.bad key is invalid",
    });
    expect(
      resolveServicesRequest({
        services: [
          {
            name: "api",
            image: "img:1",
            labels: { "com.example.backup": "" },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "invalid_service_labels",
      detail: "preview.services[0].labels.com.example.backup is required",
    });
  });

  test("empty service labels map is omitted", () => {
    expect(
      resolveServicesRequest({
        services: [{ name: "api", image: "img:1", labels: {} }],
      }),
    ).toEqual({
      ok: true,
      value: [{ name: "api", image: "img:1" }],
    });
  });
});

describe("resolvePreviewLabelsRequest", () => {
  test("absent labels stay absent", () => {
    expect(resolvePreviewLabelsRequest({})).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("passes preview labels through", () => {
    expect(
      resolvePreviewLabelsRequest({
        labels: { "com.example.backup": "true" },
      }),
    ).toEqual({
      ok: true,
      value: { "com.example.backup": "true" },
    });
  });

  test("rejects malformed preview labels with the manifest path", () => {
    expect(
      resolvePreviewLabelsRequest({ labels: { "bad key": "x" } }),
    ).toEqual({
      ok: false,
      error: "invalid_labels",
      detail: "preview.labels.bad key is invalid",
    });
    expect(
      resolvePreviewLabelsRequest({
        labels: { "com.example.backup": 1 as unknown as string },
      }),
    ).toEqual({
      ok: false,
      error: "invalid_labels",
      detail: "preview.labels.com.example.backup must be a string",
    });
  });
});

describe("resolveLabelCollisions", () => {
  const policy = {};
  const hostname = "pr-42.myapp.preview.example.com";

  test("non-colliding labels pass", () => {
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: { "com.example.backup": "true" },
        services: [
          {
            name: "api",
            image: "img:1",
            hostname: "api-pr-42.myapp.preview.example.com",
            labels: {
              "traefik.http.routers.api-pr.middlewares": "my-sso@file",
            },
          },
        ],
        policy,
      }),
    ).toEqual({ ok: true });
  });

  test("rejects a gateway-owned app key quoting preview.labels", () => {
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: { "traefik.enable": "false" },
        services: undefined,
        policy,
      }),
    ).toEqual({
      ok: false,
      error: "reserved_preview_label",
      detail: "preview.labels.traefik.enable collides with a gateway label",
    });
  });

  test("rejects a gateway-owned service key quoting the service path", () => {
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: undefined,
        services: [
          {
            name: "api",
            image: "img:1",
            hostname: "api-pr-42.myapp.preview.example.com",
            labels: { "traefik.enable": "false" },
          },
        ],
        policy,
      }),
    ).toEqual({
      ok: false,
      error: "reserved_preview_label",
      detail:
        "preview.services[0].labels.traefik.enable collides with a gateway label",
    });
  });

  test("service-level labels on internal services never collide", () => {
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: undefined,
        services: [
          {
            name: "worker",
            image: "img:1",
            labels: { "traefik.enable": "true" },
          },
        ],
        policy,
      }),
    ).toEqual({ ok: true });
  });

  test("preview-level labels still collide via the routed app container", () => {
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: { "traefik.enable": "true" },
        services: [{ name: "worker", image: "img:1" }],
        policy,
      }),
    ).toEqual({
      ok: false,
      error: "reserved_preview_label",
      detail: "preview.labels.traefik.enable collides with a gateway label",
    });
  });

  test("tls policy widens the reserved set on both seams", () => {
    const tlsPolicy = {
      traefikTls: { entrypoints: "websecure", certResolver: "myresolver" },
    };
    const router = "sprout-myapp-pr-42";
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: { [`traefik.http.routers.${router}.tls`]: "false" },
        services: undefined,
        policy: tlsPolicy,
      }),
    ).toEqual({
      ok: false,
      error: "reserved_preview_label",
      detail: `preview.labels.traefik.http.routers.${router}.tls collides with a gateway label`,
    });
    expect(
      resolveLabelCollisions({
        slug: "myapp",
        prId: 42,
        hostname,
        labels: { [`traefik.http.routers.${router}.tls`]: "false" },
        services: undefined,
        policy,
      }),
    ).toEqual({ ok: true });
  });
});
