import { describe, expect, test } from "bun:test";
import { traefikLabels } from "./labels.ts";

describe("traefikLabels", () => {
  test("sets enable, Host rule, and loadbalancer port", () => {
    expect(
      traefikLabels({
        routerName: "pb-myapp-pr-42",
        hostname: "pr-42.myapp.preview.example.com",
        port: 3000,
      }),
    ).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.pb-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.pb-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });
});
