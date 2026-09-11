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
});
