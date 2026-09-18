import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { createSqlitePreviewDb } from "./sqlite.ts";

describe("sqlite preview database (docker volumes)", () => {
  test("create provisions one named volume per preview", async () => {
    const docker = createFakeDockerClient();
    const db = createSqlitePreviewDb(docker);
    await db.createDatabase("sprout_myapp_pr42");
    expect(docker.volumesCreated).toEqual(["sprout-myapp-pr-42-sqlite"]);
    expect(await docker.listVolumes()).toEqual(["sprout-myapp-pr-42-sqlite"]);
  });

  test("create is idempotent for an existing volume", async () => {
    const docker = createFakeDockerClient();
    const db = createSqlitePreviewDb(docker);
    await db.createDatabase("sprout_myapp_pr42");
    await db.createDatabase("sprout_myapp_pr42");
    expect(await docker.listVolumes()).toEqual(["sprout-myapp-pr-42-sqlite"]);
  });

  test("drop removes the volume and tolerates a missing one", async () => {
    const docker = createFakeDockerClient();
    const db = createSqlitePreviewDb(docker);
    await db.createDatabase("sprout_myapp_pr42");
    await db.dropDatabase("sprout_myapp_pr42");
    expect(await docker.listVolumes()).toEqual([]);
    await db.dropDatabase("sprout_myapp_pr42");
  });

  test("lists only sqlite preview volumes as logical databases", async () => {
    const docker = createFakeDockerClient();
    docker.volumes.add("sprout-myapp-pr-42-sqlite");
    docker.volumes.add("some-other-volume");
    docker.volumes.add("sprout-myapp-pr-42-seed");
    const db = createSqlitePreviewDb(docker);
    expect(await db.listPreviewDatabases()).toEqual([
      { dbName: "sprout_myapp_pr42", slug: "myapp", prId: 42 },
    ]);
  });

  test("refuses unsafe database names", async () => {
    const docker = createFakeDockerClient();
    const db = createSqlitePreviewDb(docker);
    expect(db.createDatabase("evil; DROP")).rejects.toThrow();
    expect(db.dropDatabase("evil; DROP")).rejects.toThrow();
    expect(docker.volumesCreated).toEqual([]);
  });

  test("ensurePreviewRole is a no-op and ping reaches docker", async () => {
    const docker = createFakeDockerClient();
    const db = createSqlitePreviewDb(docker);
    await db.ensurePreviewRole();
    await db.ping();
  });
});
