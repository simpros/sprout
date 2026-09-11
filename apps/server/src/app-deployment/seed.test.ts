import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { runSeedImage } from "./seed.ts";

const PG = {
  host: "pg",
  port: 5432,
  user: "u",
  password: "p",
};

describe("runSeedImage", () => {
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

    const result = await runSeedImage(
      {
        docker,
        pg: PG,
        networks: { postgres: "pg-net" },
        seedTimeoutMs: 5_000,
      },
      {
        slug: "app",
        prId: 1,
        image: "seed:test",
        dbName: "db",
        env: [],
        args: [],
      },
    );

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

    const result = await runSeedImage(
      {
        docker,
        pg: PG,
        networks: { postgres: "pg-net" },
        seedTimeoutMs: 5_000,
      },
      {
        slug: "app",
        prId: 1,
        image: "seed:test",
        dbName: "db",
        env: [],
        args: [],
      },
    );

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

    const result = await runSeedImage(
      {
        docker,
        pg: PG,
        networks: { postgres: "pg-net" },
        seedTimeoutMs: 5_000,
      },
      {
        slug: "app",
        prId: 1,
        image: "seed:test",
        dbName: "db",
        env: [],
        args: [],
      },
    );

    expect(result).toEqual({
      ok: false,
      timedOut: false,
      exitCode: null,
      logs: "",
    });
  });
});
