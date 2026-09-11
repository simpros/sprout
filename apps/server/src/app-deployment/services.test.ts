import { describe, expect, test } from "bun:test";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import { createFakeDockerClient } from "../docker/fake.ts";
import { removePreviewFleet } from "./preview-containers.ts";
import { replacePreviewServices } from "./services.ts";

const baseDeps = {
  pg: {
    host: "postgres",
    port: 5432,
    user: "sprout_preview",
    password: "sekrit",
  },
  networks: {
    traefik: "sprout-traefik",
    postgres: "sprout-postgres",
  },
  previewPortDefault: 8080,
};

function companionEnv(dbName: string) {
  return [
    `PGAPPUSER=${restrictedRoleName(dbName)}`,
    `PGAPPPASSWORD=${deriveRestrictedPassword(baseDeps.pg.password, dbName)}`,
  ];
}

describe("replacePreviewServices", () => {
  test("creates services with shared PGDATABASE, dual networks, optional Traefik", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: {
        "ghcr.io/org/api:sha": 4000,
        "ghcr.io/org/worker:sha": 5000,
      },
    });

    await replacePreviewServices(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        appHostname: "pr-42.myapp.preview.example.com",
        dbName: "sprout_myapp_pr42",
        services: [
          {
            name: "api",
            image: "ghcr.io/org/api:sha",
            hostname: "api-pr-42.myapp.preview.example.com",
          },
          { name: "worker", image: "ghcr.io/org/worker:sha" },
        ],
      },
    );

    expect(docker.creates).toHaveLength(2);
    const api = docker.creates.find((c) => c.name.endsWith("-svc-api"))!;
    expect(api.name).toBe("sprout-myapp-pr-42-svc-api");
    expect(api.env).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=sprout_myapp_pr42",
      ...companionEnv("sprout_myapp_pr42"),
    ]);
    expect(api.networkNames).toEqual(["sprout-traefik", "sprout-postgres"]);
    expect(api.labels).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.sprout-myapp-pr-42-svc-api.rule":
        "Host(`api-pr-42.myapp.preview.example.com`)",
      "traefik.http.services.sprout-myapp-pr-42-svc-api.loadbalancer.server.port":
        "4000",
    });

    const worker = docker.creates.find((c) => c.name.endsWith("-svc-worker"))!;
    expect(worker.name).toBe("sprout-myapp-pr-42-svc-worker");
    expect(worker.labels).toEqual({});
    expect(worker.env).toContain("PGDATABASE=sprout_myapp_pr42");
  });

  test("path-only service uses app hostname + PathPrefix", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/admin:sha": 3000 },
    });

    await replacePreviewServices(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        appHostname: "pr-42.myapp.preview.example.com",
        dbName: "sprout_myapp_pr42",
        services: [
          {
            name: "admin",
            image: "ghcr.io/org/admin:sha",
            path: "/admin",
          },
        ],
      },
    );

    expect(docker.creates[0]!.labels[
      "traefik.http.routers.sprout-myapp-pr-42-svc-admin.rule"
    ]).toBe(
      "Host(`pr-42.myapp.preview.example.com`) && PathPrefix(`/admin`)",
    );
  });

  test("empty list clears prior services without creating", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "img:1": 80 },
    });
    await replacePreviewServices(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 1,
        appHostname: "pr-1.example.com",
        dbName: "sprout_myapp_pr1",
        services: [{ name: "api", image: "img:1" }],
      },
    );
    await replacePreviewServices(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 1,
        appHostname: "pr-1.example.com",
        dbName: "sprout_myapp_pr1",
        services: [],
      },
    );
    expect(docker.removed).toContain("sprout-myapp-pr-1-svc-api");
    expect(docker.creates).toHaveLength(1);
    expect(docker.running.has("sprout-myapp-pr-1-svc-api")).toBe(false);
  });
});

describe("removePreviewFleet", () => {
  test("removes app and all service containers for the preview", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "app:1": 80, "svc:1": 80 },
    });
    await docker.createAndStart({
      name: "sprout-myapp-pr-42",
      image: "app:1",
      env: [],
      labels: {},
      networkNames: ["sprout-traefik", "sprout-postgres"],
    });
    await docker.createAndStart({
      name: "sprout-myapp-pr-42-svc-api",
      image: "svc:1",
      env: [],
      labels: {},
      networkNames: ["sprout-traefik", "sprout-postgres"],
    });

    await removePreviewFleet(docker, "myapp", 42);
    expect(docker.removed).toEqual(
      expect.arrayContaining([
        "sprout-myapp-pr-42",
        "sprout-myapp-pr-42-svc-api",
      ]),
    );
    expect(docker.running.size).toBe(0);
  });
});
