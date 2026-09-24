import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { createFakePreviewDb } from "./fake.ts";
import { createRoutingPreviewDb } from "./routing.ts";
import { createSqlitePreviewDb } from "./sqlite.ts";

describe("routing preview database", () => {
  test("forCreate selects the backend by provider", async () => {
    const docker = createFakeDockerClient();
    const postgres = createFakePreviewDb();
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    await db.forCreate("postgres").createDatabase("sprout_myapp_pr42", {
      roles: "dual",
    });
    await db.forCreate("sqlite").createDatabase("sprout_other_pr7", {
      roles: "single",
    });
    expect(postgres.created).toEqual(["sprout_myapp_pr42"]);
    expect(docker.volumesCreated).toEqual(["sprout-other-pr-7-sqlite"]);
  });

  test("forDrop routes to the stored provider without touching the other", async () => {
    const docker = createFakeDockerClient();
    const postgres = createFakePreviewDb();
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    await db.forCreate("sqlite").createDatabase("sprout_myapp_pr42", {
      roles: "single",
    });
    await db.forDrop("sqlite").dropDatabase("sprout_myapp_pr42");
    expect(postgres.dropped).toEqual([]);
    expect(docker.volumesRemoved).toEqual(["sprout-myapp-pr-42-sqlite"]);
    await db.forDrop("postgres").dropDatabase("sprout_myapp_pr42");
    expect(postgres.dropped).toEqual(["sprout_myapp_pr42"]);
  });

  test("unknown-provider drop broadcasts and aggregates real failures", async () => {
    const postgres = createFakePreviewDb();
    postgres.dropDatabase = async () => {
      throw new Error("boom");
    };
    const db = createRoutingPreviewDb({ postgres });
    const err = await db
      .forDrop(undefined)
      .dropDatabase("sprout_myapp_pr42")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map(String)).toEqual([
      "Error: boom",
    ]);
  });

  test("unknown-provider drop tolerates missing resources", async () => {
    const db = createRoutingPreviewDb({
      postgres: createFakePreviewDb(),
      sqlite: createSqlitePreviewDb(createFakeDockerClient()),
    });
    await db.forDrop(undefined).dropDatabase("sprout_gone_pr1");
  });

  test("lists the merged postgres + sqlite catalogs without duplicates", async () => {
    const docker = createFakeDockerClient();
    docker.volumes.add("sprout-sqliteapp-pr-3-sqlite");
    const postgres = createFakePreviewDb();
    await postgres.createDatabase("sprout_pgapp_pr9", { roles: "dual" });
    await postgres.createDatabase("sprout_sqliteapp_pr3", { roles: "dual" });
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    expect(await db.listPreviewDatabases()).toEqual([
      { dbName: "sprout_pgapp_pr9", slug: "pgapp", prId: 9 },
      { dbName: "sprout_sqliteapp_pr3", slug: "sqliteapp", prId: 3 },
    ]);
  });

  test("selection fails fast when the requested backend is absent", async () => {
    const sqliteOnly = createRoutingPreviewDb({
      sqlite: createSqlitePreviewDb(createFakeDockerClient()),
    });
    expect(() => sqliteOnly.forCreate("postgres")).toThrow(
      "preview database provider not configured: postgres",
    );
    const postgresOnly = createRoutingPreviewDb({
      postgres: createFakePreviewDb(),
    });
    expect(() => postgresOnly.forCreate("sqlite")).toThrow(
      "preview database provider not configured: sqlite",
    );
  });

  test("ensurePreviewRole and ping delegate to configured backends", async () => {
    const docker = createFakeDockerClient();
    const postgres = createFakePreviewDb();
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    await db.ensurePreviewRole();
    await db.ping();
    const sqliteOnly = createRoutingPreviewDb({
      sqlite: createSqlitePreviewDb(createFakeDockerClient()),
    });
    await sqliteOnly.ensurePreviewRole();
    await sqliteOnly.ping();
  });

  test("none has no backend to create and a no-op drop", async () => {
    const db = createRoutingPreviewDb({
      postgres: createFakePreviewDb(),
      sqlite: createSqlitePreviewDb(createFakeDockerClient()),
    });
    expect(() => db.forCreate("none")).toThrow(
      "provider none has no database backend",
    );
    await db.forDrop("none").dropDatabase("sprout_myapp_pr42");
  });
});
