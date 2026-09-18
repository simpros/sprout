import { describe, expect, test } from "bun:test";
import { createFakeDockerClient } from "../docker/fake.ts";
import { createFakePreviewDb } from "./fake.ts";
import { createRoutingPreviewDb } from "./routing.ts";
import { createSqlitePreviewDb } from "./sqlite.ts";

const SQLITE_DB = { provider: "sqlite" as const, path: "/data", file: "preview.db" };

describe("routing preview database", () => {
  test("creates postgres by default and sqlite on request", async () => {
    const docker = createFakeDockerClient();
    const postgres = createFakePreviewDb();
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    await db.createDatabase("sprout_myapp_pr42");
    await db.createDatabase("sprout_other_pr7", SQLITE_DB);
    expect(postgres.created).toEqual(["sprout_myapp_pr42"]);
    expect(docker.volumesCreated).toEqual(["sprout-other-pr-7-sqlite"]);
  });

  test("drop broadcasts across backends and tolerates missing resources", async () => {
    const docker = createFakeDockerClient();
    const postgres = createFakePreviewDb();
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    await db.createDatabase("sprout_myapp_pr42", SQLITE_DB);
    await db.dropDatabase("sprout_myapp_pr42");
    expect(postgres.dropped).toEqual(["sprout_myapp_pr42"]);
    expect(docker.volumesRemoved).toEqual(["sprout-myapp-pr-42-sqlite"]);
    await db.dropDatabase("sprout_gone_pr1");
  });

  test("drop surfaces real backend failures", async () => {
    const postgres = createFakePreviewDb();
    postgres.dropDatabase = async () => {
      throw new Error("boom");
    };
    const db = createRoutingPreviewDb({ postgres });
    expect(db.dropDatabase("sprout_myapp_pr42")).rejects.toThrow("boom");
  });

  test("lists the merged postgres + sqlite catalogs", async () => {
    const docker = createFakeDockerClient();
    docker.volumes.add("sprout-sqliteapp-pr-3-sqlite");
    const postgres = createFakePreviewDb();
    await postgres.createDatabase("sprout_pgapp_pr9");
    const db = createRoutingPreviewDb({
      postgres,
      sqlite: createSqlitePreviewDb(docker),
    });
    expect(await db.listPreviewDatabases()).toEqual([
      { dbName: "sprout_pgapp_pr9", slug: "pgapp", prId: 9 },
      { dbName: "sprout_sqliteapp_pr3", slug: "sqliteapp", prId: 3 },
    ]);
  });

  test("create fails fast when the requested backend is absent", async () => {
    const sqliteOnly = createRoutingPreviewDb({
      sqlite: createSqlitePreviewDb(createFakeDockerClient()),
    });
    expect(sqliteOnly.createDatabase("sprout_myapp_pr42")).rejects.toThrow(
      "preview database provider not configured: postgres",
    );
    const postgresOnly = createRoutingPreviewDb({
      postgres: createFakePreviewDb(),
    });
    expect(
      postgresOnly.createDatabase("sprout_myapp_pr42", SQLITE_DB),
    ).rejects.toThrow("preview database provider not configured: sqlite");
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
});
