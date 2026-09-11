import { describe, expect, test } from "bun:test";
import { traefikLabels } from "./labels.ts";

describe("traefikLabels", () => {
  test("sets enable, Host rule, tls, and loadbalancer port", () => {
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
      "traefik.http.routers.sprout-myapp-pr-42.tls": "true",
      "traefik.http.services.sprout-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });

  test("adds entrypoints when configured", () => {
    expect(
      traefikLabels({
        routerName: "sprout-app-pr-1",
        hostname: "pr-1.example.com",
        port: 8080,
        entrypoints: "https",
      })[`traefik.http.routers.sprout-app-pr-1.entrypoints`],
    ).toBe("https");
  });

  test("adds certresolver when configured", () => {
    expect(
      traefikLabels({
        routerName: "sprout-app-pr-1",
        hostname: "pr-1.example.com",
        port: 8080,
        certResolver: "myresolver",
      })[`traefik.http.routers.sprout-app-pr-1.tls.certresolver`],
    ).toBe("myresolver");
  });

  test("omits entrypoints and certresolver when blank", () => {
    const labels = traefikLabels({
      routerName: "sprout-app-pr-1",
      hostname: "pr-1.example.com",
      port: 8080,
      entrypoints: "  ",
      certResolver: "",
    });
    expect(labels).not.toHaveProperty(
      "traefik.http.routers.sprout-app-pr-1.entrypoints",
    );
    expect(labels).not.toHaveProperty(
      "traefik.http.routers.sprout-app-pr-1.tls.certresolver",
    );
    expect(labels["traefik.http.routers.sprout-app-pr-1.tls"]).toBe("true");
  });
});
