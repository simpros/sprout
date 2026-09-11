import { describe, expect, test } from "bun:test";
import { traefikLabels } from "./labels.ts";

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
