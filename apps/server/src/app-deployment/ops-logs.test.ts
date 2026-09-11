import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { fetchLiveContainerLogs } from "./ops.ts";

describe("fetchLiveContainerLogs", () => {
  test("returns live app and seed text in parallel", async () => {
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

    const live = await fetchLiveContainerLogs(docker, {
      slug: "app",
      prId: 1,
      tail: 100,
    });

    expect(live).toEqual({ app: "app live\n", seed: "seed live\n" });
  });

  test("returns null for missing containers", async () => {
    const docker = createFakeDockerClient();
    await docker.createAndStart({
      name: "sprout-app-pr-1",
      image: "app:test",
      env: [],
      labels: {},
      networkNames: ["net"],
    });
    docker.logs.set("sprout-app-pr-1", "app live\n");

    const live = await fetchLiveContainerLogs(docker, {
      slug: "app",
      prId: 1,
      tail: 100,
    });

    expect(live).toEqual({ app: "app live\n", seed: null });
  });
});
