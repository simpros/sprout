import { describe, expect, test } from "bun:test";
import { defaultDbSpec } from "@sprout/preview-env";
import { createFakeDockerClient } from "../docker/fake.ts";
import { runSeedImage, type SeedImageInput } from "./seed.ts";
import {
  resolvePreviewPlan,
  type PreviewMaterializationCtx,
} from "../preview/runtime.ts";

function materialization(): PreviewMaterializationCtx {
  return {
    traefikNetwork: "traefik-net",
    postgres: {
      pg: { host: "pg", port: 5432, user: "u", password: "p" },
      network: "pg-net",
    },
  };
}

function input(overrides: Partial<SeedImageInput> = {}): SeedImageInput {
  return {
    slug: "app",
    prId: 1,
    image: "seed:test",
    env: [],
    args: [],
    plan: resolvePreviewPlan(materialization(), {
      spec: defaultDbSpec(),
      dbName: "db",
      slug: "app",
      prId: 1,
      roles: "single",
    }),
    ...overrides,
  };
}

const deps = (docker: ReturnType<typeof createFakeDockerClient>) => ({
  docker,
  seedTimeoutMs: 5_000,
});

describe("runSeedImage", () => {
  test("creates the one-shot seed container with empty labels", async () => {
    const docker = createFakeDockerClient();
    const result = await runSeedImage(deps(docker), input());
    expect(result).toEqual({ ok: true });
    expect(docker.creates).toHaveLength(1);
    expect(docker.creates[0]!.labels).toEqual({});
  });

  test("captures logs before remove on non-zero exit", async () => {
    const docker = createFakeDockerClient({
      waitResults: { "sprout-app-pr-1-seed": { exitCode: 7 } },
    });
    const originalCreate = docker.createAndStart.bind(docker);
    docker.createAndStart = async (spec) => {
      const created = await originalCreate(spec);
      docker.logs.set(spec.name, "boom\n");
      return created;
    };

    const result = await runSeedImage(deps(docker), input());

    expect(result).toEqual({
      ok: false,
      timedOut: false,
      exitCode: 7,
      logs: "boom\n",
    });
    expect(docker.running.has("sprout-app-pr-1-seed")).toBe(false);
  });

  test("captures logs before remove when waitForExit throws", async () => {
    const docker = createFakeDockerClient();
    const originalCreate = docker.createAndStart.bind(docker);
    docker.createAndStart = async (spec) => {
      const created = await originalCreate(spec);
      docker.logs.set(spec.name, "still there\n");
      return created;
    };
    docker.waitForExit = async () => {
      throw new Error("Docker wait cid returned no StatusCode");
    };

    const result = await runSeedImage(deps(docker), input());

    expect(result).toEqual({
      ok: false,
      timedOut: false,
      exitCode: null,
      logs: "still there\n",
    });
    expect(docker.running.has("sprout-app-pr-1-seed")).toBe(false);
  });

  test("returns empty logs when create never starts a container", async () => {
    const docker = createFakeDockerClient();
    docker.createAndStart = async () => {
      throw new Error("docker create boom");
    };

    const result = await runSeedImage(deps(docker), input());

    expect(result).toEqual({
      ok: false,
      timedOut: false,
      exitCode: null,
      logs: "",
    });
  });
});
