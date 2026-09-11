import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { bindPreviewOps } from "../app-deployment/ops.ts";
import {
  mergePreviewLogs,
  mergeSeedText,
  readPreviewLogs,
} from "./preview-logs.ts";

describe("mergeSeedText", () => {
  test("prefers live text when the seed container exists", () => {
    expect(mergeSeedText("seed live\n", "seed stored\n")).toBe("seed live\n");
  });

  test("keeps empty live text when the seed container exists", () => {
    expect(mergeSeedText("", "seed stored\n")).toBe("");
  });

  test("falls back to stored text when the seed container is missing", () => {
    expect(mergeSeedText(null, "seed stored\n")).toBe("seed stored\n");
  });

  test("returns empty string when both sources are absent", () => {
    expect(mergeSeedText(null, null)).toBe("");
  });
});

describe("mergePreviewLogs", () => {
  test("coerces missing app container to empty string", () => {
    expect(
      mergePreviewLogs({ app: null, seed: null }, "stored\n"),
    ).toEqual({ app: "", seed: "stored\n" });
  });
});

describe("readPreviewLogs", () => {
  const opsDeps = {
    pg: {
      host: "postgres",
      port: 5432,
      user: "sprout_preview",
      password: "preview-secret",
    },
    networks: {
      traefik: "sprout-traefik",
      postgres: "sprout-postgres",
    },
    previewPortDefault: 8080,
    seedTimeoutMs: 180_000,
  };

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
    const app = bindPreviewOps({ docker, ...opsDeps });

    const bundle = await readPreviewLogs(
      { app },
      {
        slug: "app",
        prId: 1,
        tail: 100,
        storedSeedLog: "seed stored\n",
      },
    );

    expect(bundle).toEqual({ app: "app live\n", seed: "seed live\n" });
  });

  test("empty live seed beats stored blob when container exists", async () => {
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
    docker.logs.set("sprout-app-pr-1-seed", "");
    const app = bindPreviewOps({ docker, ...opsDeps });

    const bundle = await readPreviewLogs(
      { app },
      {
        slug: "app",
        prId: 1,
        tail: 100,
        storedSeedLog: "seed stored\n",
      },
    );

    expect(bundle).toEqual({ app: "app live\n", seed: "" });
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
    const app = bindPreviewOps({ docker, ...opsDeps });

    const bundle = await readPreviewLogs(
      { app },
      {
        slug: "app",
        prId: 1,
        tail: 100,
        storedSeedLog: "seed stored\n",
      },
    );

    expect(bundle).toEqual({ app: "app live\n", seed: "seed stored\n" });
  });
});
