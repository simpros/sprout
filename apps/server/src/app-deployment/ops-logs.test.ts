import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { resolvePreviewLogs } from "./ops.ts";

describe("resolvePreviewLogs", () => {
  test("prefers live seed container over stored seed log", async () => {
    const docker = createFakeDockerClient();
    await docker.createAndStart({
      name: "sprout-app-pr-1",
      image: "app:test",
      env: [],
      labels: {},
      networkNames: ["net"],
    });
    await docker.createAndStart({
      name: "sprout-app-pr-1-seed",
      image: "seed:test",
      env: [],
      labels: {},
      networkNames: ["net"],
    });
    docker.logs.set("sprout-app-pr-1", "app live\n");
    docker.logs.set("sprout-app-pr-1-seed", "seed live\n");

    const bundle = await resolvePreviewLogs(docker, {
      slug: "app",
      prId: 1,
      tail: 100,
      storedSeedLog: "seed stored\n",
    });

    expect(bundle).toEqual({ app: "app live\n", seed: "seed live\n" });
  });

  test("falls back to stored seed log when seed container is gone", async () => {
    const docker = createFakeDockerClient();
    await docker.createAndStart({
      name: "sprout-app-pr-1",
      image: "app:test",
      env: [],
      labels: {},
      networkNames: ["net"],
    });
    docker.logs.set("sprout-app-pr-1", "app live\n");

    const bundle = await resolvePreviewLogs(docker, {
      slug: "app",
      prId: 1,
      tail: 100,
      storedSeedLog: "seed stored\n",
    });

    expect(bundle).toEqual({ app: "app live\n", seed: "seed stored\n" });
  });
});
