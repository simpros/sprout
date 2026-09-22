import { describe, expect, test } from "bun:test";
import {
  isReservedPreviewLabel,
  mergePreviewLabels,
  traefikLabels,
} from "./labels.ts";

describe("traefikLabels", () => {
  test("sets enable, Host rule, and loadbalancer port without TLS by default", () => {
    expect(
      traefikLabels({
        routerName: "sprout-myapp-pr-42",
        hostname: "pr-42.myapp.preview.example.com",
        port: 3000,
      }),
    ).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.sprout-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.sprout-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });

  test("emits tls + entrypoints when TLS policy is set", () => {
    expect(
      traefikLabels({
        routerName: "sprout-app-pr-1",
        hostname: "pr-1.example.com",
        port: 8080,
        tls: { entrypoints: "https" },
      }),
    ).toMatchObject({
      "traefik.http.routers.sprout-app-pr-1.tls": "true",
      "traefik.http.routers.sprout-app-pr-1.entrypoints": "https",
    });
  });

  test("emits certresolver when included in TLS policy", () => {
    expect(
      traefikLabels({
        routerName: "sprout-app-pr-1",
        hostname: "pr-1.example.com",
        port: 8080,
        tls: { entrypoints: "https", certResolver: "myresolver" },
      })[`traefik.http.routers.sprout-app-pr-1.tls.certresolver`],
    ).toBe("myresolver");
  });

  test("omits certresolver when TLS policy has none", () => {
    const labels = traefikLabels({
      routerName: "sprout-app-pr-1",
      hostname: "pr-1.example.com",
      port: 8080,
      tls: { entrypoints: "websecure" },
    });
    expect(labels).not.toHaveProperty(
      "traefik.http.routers.sprout-app-pr-1.tls.certresolver",
    );
    expect(labels["traefik.http.routers.sprout-app-pr-1.tls"]).toBe("true");
    expect(labels["traefik.http.routers.sprout-app-pr-1.entrypoints"]).toBe(
      "websecure",
    );
  });

  test("emits middleware attachment and forwardAuth definition when set", () => {
    expect(
      traefikLabels({
        routerName: "sprout-app-pr-1",
        hostname: "pr-1.example.com",
        port: 8080,
        forwardAuth: {
          middleware: "voidauth",
          address: "https://auth.example.com/api/authz/forward-auth",
        },
      }),
    ).toMatchObject({
      "traefik.http.routers.sprout-app-pr-1.middlewares": "voidauth",
      "traefik.http.middlewares.voidauth.forwardauth.address":
        "https://auth.example.com/api/authz/forward-auth",
      "traefik.http.middlewares.voidauth.forwardauth.trustForwardHeader":
        "true",
      "traefik.http.middlewares.voidauth.forwardauth.authResponseHeaders":
        "Remote-User,Remote-Email,Remote-Groups",
    });
  });

  test("omits middleware labels when forwardAuth is unset", () => {
    const labels = traefikLabels({
      routerName: "sprout-app-pr-1",
      hostname: "pr-1.example.com",
      port: 8080,
    });
    expect(labels).not.toHaveProperty(
      "traefik.http.routers.sprout-app-pr-1.middlewares",
    );
    expect(
      Object.keys(labels).some((k) => k.includes(".middlewares.")),
    ).toBe(false);
  });

  test("combines Host and PathPrefix when pathPrefix is set", () => {
    expect(
      traefikLabels({
        routerName: "sprout-myapp-pr-42-svc-admin",
        hostname: "pr-42.myapp.preview.example.com",
        port: 3000,
        pathPrefix: "/admin",
      })[`traefik.http.routers.sprout-myapp-pr-42-svc-admin.rule`],
    ).toBe(
      "Host(`pr-42.myapp.preview.example.com`) && PathPrefix(`/admin`)",
    );
  });
});

describe("mergePreviewLabels", () => {
  const gateway = traefikLabels({
    routerName: "sprout-myapp-pr-42",
    hostname: "pr-42.myapp.preview.example.com",
    port: 3000,
  });

  test("returns the gateway set byte-identical when no adopter labels", () => {
    expect(mergePreviewLabels(gateway, undefined)).toEqual(gateway);
    expect(mergePreviewLabels(gateway, undefined, undefined)).toEqual(gateway);
  });

  test("passes non-colliding traefik and non-traefik keys verbatim", () => {
    expect(
      mergePreviewLabels(gateway, {
        "traefik.docker.network": "traefik",
        "traefik.http.routers.api-pr.middlewares": "my-sso@file",
        "com.example.backup": "true",
      }),
    ).toEqual({
      ...gateway,
      "traefik.docker.network": "traefik",
      "traefik.http.routers.api-pr.middlewares": "my-sso@file",
      "com.example.backup": "true",
    });
  });

  test("rejects a gateway-owned key with the preview manifest path", () => {
    let err: unknown;
    try {
      mergePreviewLabels(gateway, { "traefik.enable": "false" });
    } catch (e) {
      err = e;
    }
    expect(isReservedPreviewLabel(err)).toBe(true);
    if (isReservedPreviewLabel(err)) {
      expect(err.manifestPath).toBe("preview.labels.traefik.enable");
      expect(err.message).toContain("preview.labels.traefik.enable");
    }
  });

  test("derives the reserved set from emission, not a hard-coded list", () => {
    const withTls = traefikLabels({
      routerName: "sprout-myapp-pr-42",
      hostname: "pr-42.myapp.preview.example.com",
      port: 3000,
      tls: { entrypoints: "websecure", certResolver: "myresolver" },
      forwardAuth: {
        middleware: "voidauth",
        address: "https://auth.example.com/api/authz/forward-auth",
      },
    });
    for (const key of Object.keys(withTls)) {
      let err: unknown;
      try {
        mergePreviewLabels(withTls, { [key]: "x" });
      } catch (e) {
        err = e;
      }
      expect(isReservedPreviewLabel(err)).toBe(true);
    }
    expect(Object.keys(withTls).length).toBeGreaterThan(
      Object.keys(gateway).length,
    );
  });

  test("quotes the service manifest path when the service level collides", () => {
    const svcGateway = traefikLabels({
      routerName: "sprout-myapp-pr-42-svc-api",
      hostname: "api-pr-42.myapp.preview.example.com",
      port: 4000,
    });
    const rule = "traefik.http.routers.sprout-myapp-pr-42-svc-api.rule";
    let err: unknown;
    try {
      mergePreviewLabels(
        svcGateway,
        { "com.example.backup": "true" },
        { labels: { [rule]: "Host(`evil`)" }, index: 0 },
      );
    } catch (e) {
      err = e;
    }
    expect(isReservedPreviewLabel(err)).toBe(true);
    if (isReservedPreviewLabel(err)) {
      expect(err.manifestPath).toBe(`preview.services[0].labels.${rule}`);
    }
  });

  test("per-service value wins over the preview level for the same key", () => {
    expect(
      mergePreviewLabels(
        {},
        { "com.example.team": "preview", "com.example.backup": "true" },
        { labels: { "com.example.team": "service" }, index: 1 },
      ),
    ).toEqual({
      "com.example.team": "service",
      "com.example.backup": "true",
    });
  });

  test("internal services (empty gateway set) receive every label", () => {
    expect(
      mergePreviewLabels(
        {},
        { "traefik.docker.network": "traefik" },
        { labels: { "com.example.backup": "true" }, index: 0 },
      ),
    ).toEqual({
      "traefik.docker.network": "traefik",
      "com.example.backup": "true",
    });
  });
});
