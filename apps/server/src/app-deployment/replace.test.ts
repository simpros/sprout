import { describe, expect, test } from "bun:test";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import { defaultDbSpec, type PreviewEnvMap } from "@sprout/preview-env";
import { createFakeDockerClient } from "../docker/fake.ts";
import { bindPreviewOps } from "./ops.ts";
import { removePreviewFleet } from "./preview-containers.ts";
import { replacePreviewApp } from "./replace.ts";
import {
  resolvePreviewPlan,
  type PreviewDbPlan,
  type PreviewMaterializationCtx,
} from "../preview/runtime.ts";

const PG_PASSWORD = "sekrit";

const baseDeps = {
  previewPortDefault: 8080,
};

function materialization(): PreviewMaterializationCtx {
  return {
    traefikNetwork: "sprout-traefik",
    postgres: {
      pg: {
        host: "postgres",
        port: 5432,
        user: "sprout_preview",
        password: PG_PASSWORD,
      },
      network: "sprout-postgres",
    },
  };
}

function postgresPlan(
  dbName = "sprout_myapp_pr42",
  connectionEnv?: PreviewEnvMap,
): PreviewDbPlan {
  return resolvePreviewPlan(materialization(), {
    spec: defaultDbSpec(),
    dbName,
    slug: "myapp",
    prId: 42,
    connectionEnv,
  });
}

function companionEnv(dbName: string) {
  return [
    `PGAPPUSER=${restrictedRoleName(dbName)}`,
    `PGAPPPASSWORD=${deriveRestrictedPassword(PG_PASSWORD, dbName)}`,
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
        appEnv: [],
        plan: postgresPlan(),
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
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        appEnv: [],
        plan: postgresPlan(),
        traefikTls: { entrypoints: "websecure", certResolver: "myresolver" },
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
      { docker, ...baseDeps },
      {
        slug: "myapp",
        prId: 42,
        hostname: "pr-42.myapp.preview.example.com",
        image: "ghcr.io/org/app:sha",
        appEnv: [],
        plan: postgresPlan(),
        traefikForwardAuth: {
          middleware: "voidauth",
          address: "https://auth.example.com/api/authz/forward-auth",
        },
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
        appEnv: [],
        plan: postgresPlan("prev_myapp_pr42", {
          PGHOST: "DATABASE_HOST",
          PGUSER: "DATABASE_USER",
        }),
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
        appEnv: [
          "BETTER_AUTH_SECRET=sekrit",
          "DATABASE_HOST=attacker",
          "PGPASSWORD=stolen",
          "PGHOST=leftover",
        ],
        plan: postgresPlan("sprout_myapp_pr42", {
          PGHOST: "DATABASE_HOST",
        }),
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
        appEnv: [],
        plan: postgresPlan("sprout_myapp_pr7"),
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
      appEnv: [] as string[],
      plan: postgresPlan("sprout_widgets_pr3"),
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

  test("merges preview labels onto the app container", async () => {
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
        appEnv: [],
        plan: postgresPlan(),
        labels: {
          "traefik.docker.network": "traefik",
          "com.example.backup": "true",
        },
      },
    );

    expect(docker.creates[0]!.labels).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.sprout-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.sprout-myapp-pr-42.loadbalancer.server.port": "3000",
      "traefik.docker.network": "traefik",
      "com.example.backup": "true",
    });
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
      appEnv: [],
      plan: postgresPlan("sprout_myapp_pr1"),
    });
    expect(containerId).toBe("fake-1");
    expect(docker.pulls).toEqual(["img:1"]);
    await app.remove("myapp", 1);
    expect(docker.removed).toContain("sprout-myapp-pr-1");
    expect(await app.list()).toEqual([]);
  });

  test("waitHealthy probes the plan networks in order via injected probe", async () => {
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
      appEnv: [],
      plan: postgresPlan("sprout_myapp_pr1"),
    });
    expect(
      await app.waitHealthy(
        containerId,
        port,
        {
          path: "/health",
          intervalMs: 1,
          timeoutMs: 5_000,
          expectStatus: 200,
        },
        ["sprout-traefik", "sprout-postgres"],
      ),
    ).toBe("ok");
    expect(hits).toEqual(["http://10.99.0.1:3000/health"]);
  });
});
