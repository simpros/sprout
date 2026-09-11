import { describe, expect, test } from "bun:test";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import { createFakeDockerClient } from "../docker/fake.ts";
import { bindPreviewOps } from "./ops.ts";
import { removePreviewFleet } from "./preview-containers.ts";
import { replacePreviewApp } from "./replace.ts";

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

const bindDeps = {
  ...baseDeps,
  seedTimeoutMs: 180_000,
};

describe("removePreviewFleet", () => {
  test("removes the stable preview container name", async () => {
    const docker = createFakeDockerClient();
    await removePreviewFleet(docker, "myapp", 42);
    expect(docker.removed).toEqual(["sprout-myapp-pr-42"]);
  });
});

describe("replacePreviewApp", () => {
  test("removes prior container, creates with PG* env, dual networks, Traefik labels", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/app:sha": 3000 },
    });

    const result = await replacePreviewApp(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        dbName: "sprout_myapp_pr42",
        appEnv: [],
      },
    );

    expect(result).toEqual({ containerId: "fake-1", port: 3000 });
    expect(docker.pulls).toEqual([]);
    expect(docker.removed).toEqual(["sprout-myapp-pr-42"]);
    expect(docker.creates).toHaveLength(1);
    const created = docker.creates[0]!;
    expect(created.name).toBe("sprout-myapp-pr-42");
    expect(created.image).toBe("ghcr.io/org/app:sha");
    expect(created.env).toEqual([
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=sprout_myapp_pr42",
      ...companionEnv("sprout_myapp_pr42"),
    ]);
    expect(created.networkNames).toEqual([
      "sprout-traefik",
      "sprout-postgres",
    ]);
    expect(created.labels).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.sprout-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.sprout-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });

  test("passes Traefik TLS policy into labels", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/app:sha": 3000 },
    });

    await replacePreviewApp(
      {
        docker,
        ...baseDeps,
        traefikTls: { entrypoints: "websecure", certResolver: "myresolver" },
      },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        dbName: "sprout_myapp_pr42",
        appEnv: [],
      },
    );

    expect(docker.creates[0]!.labels).toMatchObject({
      "traefik.http.routers.sprout-myapp-pr-42.tls": "true",
      "traefik.http.routers.sprout-myapp-pr-42.entrypoints": "websecure",
      "traefik.http.routers.sprout-myapp-pr-42.tls.certresolver": "myresolver",
    });
  });

  test("passes Traefik forwardAuth policy into labels", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/app:sha": 3000 },
    });

    await replacePreviewApp(
      {
        docker,
        ...baseDeps,
        traefikForwardAuth: {
          middleware: "voidauth",
          address: "https://auth.example.com/api/authz/forward-auth",
        },
      },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        dbName: "sprout_myapp_pr42",
        appEnv: [],
      },
    );

    expect(docker.creates[0]!.labels).toMatchObject({
      "traefik.http.routers.sprout-myapp-pr-42.middlewares": "voidauth",
      "traefik.http.middlewares.voidauth.forwardauth.address":
        "https://auth.example.com/api/authz/forward-auth",
      "traefik.http.middlewares.voidauth.forwardauth.trustForwardHeader":
        "true",
      "traefik.http.middlewares.voidauth.forwardauth.authResponseHeaders":
        "Remote-User,Remote-Email,Remote-Groups",
    });
  });

  test("applies connection env remap on create (replace, not alias)", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/app:sha": 3000 },
    });

    await replacePreviewApp(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        dbName: "prev_myapp_pr42",
        appEnv: [],
        connectionEnv: {
          PGHOST: "DATABASE_HOST",
          PGUSER: "DATABASE_USER",
        },
      },
    );

    expect(docker.creates[0]!.env).toEqual([
      "DATABASE_HOST=postgres",
      "PGPORT=5432",
      "DATABASE_USER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=prev_myapp_pr42",
      ...companionEnv("prev_myapp_pr42"),
    ]);
  });

  test("strips colliding appEnv keys; gateway connection env wins", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "ghcr.io/org/app:sha": 3000 },
    });

    await replacePreviewApp(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        dbName: "sprout_myapp_pr42",
        appEnv: [
          "BETTER_AUTH_SECRET=sekrit",
          "DATABASE_HOST=attacker",
          "PGPASSWORD=stolen",
          "PGHOST=leftover",
        ],
        connectionEnv: {
          PGHOST: "DATABASE_HOST",
        },
      },
    );

    expect(docker.creates[0]!.env).toEqual([
      "BETTER_AUTH_SECRET=sekrit",
      "DATABASE_HOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=sekrit",
      "PGDATABASE=sprout_myapp_pr42",
      ...companionEnv("sprout_myapp_pr42"),
    ]);
  });

  test("falls back to previewPortDefault when image has no EXPOSE", async () => {
    const docker = createFakeDockerClient();
    const result = await replacePreviewApp(
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 7,
        hostname: "pr-7.example.com",
        image: "ghcr.io/org/app:noexpose",
        dbName: "sprout_myapp_pr7",
        appEnv: [],
      },
    );
    expect(result.containerId).toBe("fake-1");
    expect(
      docker.creates[0]!.labels[
        "traefik.http.services.sprout-myapp-pr-7.loadbalancer.server.port"
      ],
    ).toBe("8080");
  });

  test("replace removes then creates again under the same name", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "img:v1": 80, "img:v2": 80 },
    });
    const input = {
      slug: "widgets",
      prId: 3,
      hostname: "pr-3.widgets.example.com",
      dbName: "sprout_widgets_pr3",
      appEnv: [] as string[],
    };
    await replacePreviewApp(
      { docker, ...baseDeps },
      { ...input, image: "img:v1" },
    );
    await replacePreviewApp(
      { docker, ...baseDeps },
      { ...input, image: "img:v2" },
    );
    expect(docker.removed).toEqual(["sprout-widgets-pr-3", "sprout-widgets-pr-3"]);
    expect(docker.creates.map((c) => c.image)).toEqual(["img:v1", "img:v2"]);
    expect(docker.running.get("sprout-widgets-pr-3")?.spec.image).toBe("img:v2");
  });
});

describe("bindPreviewOps", () => {
  test("pulls via docker and replaces without exposing config to caller", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "img:1": 3000 },
    });
    const app = bindPreviewOps({ docker, ...bindDeps });
    await app.pullImage("img:1");
    const { containerId } = await app.replace({
      slug: "myapp",
      prId: 1,
      hostname: "pr-1.example.com",
      image: "img:1",
      dbName: "sprout_myapp_pr1",
      appEnv: [],
    });
    expect(containerId).toBe("fake-1");
    expect(docker.pulls).toEqual(["img:1"]);
    await app.remove("myapp", 1);
    expect(docker.removed).toContain("sprout-myapp-pr-1");
    expect(await app.list()).toEqual([]);
  });

  test("waitHealthy polls postgres-network IP via injected probe", async () => {
    const docker = createFakeDockerClient({
      exposedPorts: { "img:1": 3000 },
    });
    const hits: string[] = [];
    const app = bindPreviewOps({
      docker,
      ...bindDeps,
      healthProbe: {
        async getStatus(url) {
          hits.push(url);
          return 200;
        },
      },
    });
    const { containerId, port } = await app.replace({
      slug: "myapp",
      prId: 1,
      hostname: "pr-1.example.com",
      image: "img:1",
      dbName: "sprout_myapp_pr1",
      appEnv: [],
    });
    expect(
      await app.waitHealthy(containerId, port, {
        path: "/health",
        intervalMs: 1,
        timeoutMs: 5_000,
        expectStatus: 200,
      }),
    ).toBe("ok");
    // networkNames = [traefik, postgres] → postgres gets 10.99.0.2
    expect(hits).toEqual(["http://10.99.0.2:3000/health"]);
  });
});
