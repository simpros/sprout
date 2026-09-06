import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { bindTestPreviewApp, createTestDb } from "../http/test-helpers.ts";
import { previews, repos } from "../infrastructure/db/schema.ts";
import type { PreviewDb } from "../preview-db/port.ts";
import { createLiveSweepPorts } from "./live-ports.ts";
import { runSweepPass } from "./reconcile.ts";

function stubPreviewDb(
  partial: Partial<PreviewDb> & Pick<PreviewDb, "listPreviewDatabases">,
): PreviewDb {
  return {
    createDatabase: async () => {},
    dropDatabase: async () => {},
    ping: async () => {},
    ...partial,
  };
}

describe("createLiveSweepPorts", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    setSystemTime();
    await cleanup?.();
    cleanup = undefined;
  });

  test("marks SQLite preview removed and drops DB/container on pr-not-open", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 10,
      slug: "widgets",
      dbName: "prev_widgets_pr10",
      hostname: "pr-10.example.com",
      containerId: "ctr-10",
      status: "running",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const droppedDbs: string[] = [];
    const docker = createFakeDockerClient();
    const previewDb = stubPreviewDb({
      listPreviewDatabases: async () => [
        { dbName: "prev_widgets_pr10", slug: "widgets", prId: 10 },
      ],
      dropDatabase: async (dbName) => {
        droppedDbs.push(dbName);
      },
    });

    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb,
      forge: {
        listOpenPrIds: async () => [],
      },
      ttlHours: 72,
      log: () => {},
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(droppedDbs).toEqual(["prev_widgets_pr10"]);
    expect(docker.removed).toEqual(["pb-widgets-pr-10"]);

    const rows = await testDb.db.select().from(previews);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("removed");
    expect(rows[0]?.containerId).toBeNull();
  });

  test("parses ISO-Z createdAt into createdAtMs", async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 1,
      slug: "widgets",
      dbName: "prev_widgets_pr1",
      hostname: "pr-1.example.com",
      containerId: null,
      status: "running",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
      }),
      forge: { listOpenPrIds: async () => [1] },
      ttlHours: 72,
    });

    const listed = await ports.listPreviews();
    expect(listed[0]?.createdAt).toBe("2026-09-02T12:00:00.000Z");
    expect(listed[0]?.createdAtMs).toBe(
      Date.parse("2026-09-02T12:00:00.000Z"),
    );
  });

  test("invalid createdAt skips TTL but protects catalog from orphan GC", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 1,
      slug: "widgets",
      dbName: "prev_widgets_pr1",
      hostname: "pr-1.example.com",
      containerId: null,
      status: "running",
      createdAt: "not-a-timestamp",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const droppedDbs: string[] = [];
    const logs: string[] = [];
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [
          { dbName: "prev_widgets_pr1", slug: "widgets", prId: 1 },
        ],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: { listOpenPrIds: async () => [1] },
      ttlHours: 72,
      log: (message) => {
        logs.push(message);
      },
    });

    const listed = await ports.listPreviews();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.createdAtMs).toBeNull();
    expect(logs.some((m) => m.includes("invalid createdAt"))).toBe(true);

    const result = await runSweepPass(ports);
    expect(result.deletions).toEqual([]);
    expect(droppedDbs).toEqual([]);

    const rows = await testDb.db.select().from(previews);
    expect(rows[0]?.status).toBe("running");
  });

  test("space-separated legacy createdAt is null; skips TTL; protects orphans", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 1,
      slug: "widgets",
      dbName: "prev_widgets_pr1",
      hostname: "pr-1.example.com",
      containerId: null,
      status: "running",
      createdAt: "2026-09-02 12:00:00",
      updatedAt: "2026-09-02 12:00:00",
    });

    const droppedDbs: string[] = [];
    const logs: string[] = [];
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [
          { dbName: "prev_widgets_pr1", slug: "widgets", prId: 1 },
        ],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: { listOpenPrIds: async () => [1] },
      ttlHours: 1,
      log: (message) => {
        logs.push(message);
      },
    });

    const listed = await ports.listPreviews();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.createdAtMs).toBeNull();
    expect(logs.some((m) => m.includes("invalid createdAt"))).toBe(true);

    const result = await runSweepPass(ports);
    expect(result.deletions).toEqual([]);
    expect(droppedDbs).toEqual([]);

    const rows = await testDb.db.select().from(previews);
    expect(rows[0]?.status).toBe("running");
  });

  test("marks error when DB drop fails (retryable)", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 10,
      slug: "widgets",
      dbName: "prev_widgets_pr10",
      hostname: "pr-10.example.com",
      containerId: "ctr-10",
      status: "running",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const logs: string[] = [];
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
        dropDatabase: async () => {
          throw new Error("postgres busy");
        },
      }),
      forge: { listOpenPrIds: async () => [] },
      ttlHours: 72,
      log: (message) => {
        logs.push(message);
      },
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(logs.some((m) => m.includes("sweep drop failed"))).toBe(true);

    const rows = await testDb.db.select().from(previews);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.containerId).toBe("ctr-10");
  });

  test("container remove failure is best-effort; DROP still proceeds", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 10,
      slug: "widgets",
      dbName: "prev_widgets_pr10",
      hostname: "pr-10.example.com",
      containerId: "ctr-10",
      status: "running",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const droppedDbs: string[] = [];
    const docker: FakeDockerClient = createFakeDockerClient();
    docker.removeByName = async () => {
      throw new Error("docker boom");
    };

    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [
          { dbName: "prev_widgets_pr10", slug: "widgets", prId: 10 },
        ],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: { listOpenPrIds: async () => [] },
      ttlHours: 72,
      log: () => {},
    });

    const result = await runSweepPass(ports);
    expect(result.forgeRepoFailures).toEqual([]);
    expect(result.deletions).toEqual([
      {
        reason: "sweep:pr-not-open",
        canonicalRepoId: "https://github.com/acme/widgets",
        prId: 10,
        slug: "widgets",
        dbName: "prev_widgets_pr10",
        createdAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
    expect(droppedDbs).toEqual(["prev_widgets_pr10"]);

    const rows = await testDb.db.select().from(previews);
    expect(rows[0]?.status).toBe("removed");
    expect(rows[0]?.containerId).toBeNull();
  });

  test("aborts stale TTL plan after redeploy rewrote dbName", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    // Row already redeployed with a new identity since the plan was built.
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "widgets",
      dbName: "prev_widgets_pr42",
      hostname: "pr-42.example.com",
      containerId: null,
      status: "running",
      createdAt: "2026-09-03T11:00:00.000Z",
      updatedAt: "2026-09-03T11:00:00.000Z",
    });

    const droppedDbs: string[] = [];
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: { listOpenPrIds: async () => [42] },
      ttlHours: 72,
    });

    const removed = await ports.drop({
      reason: "sweep:ttl-expired",
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "old",
      dbName: "prev_old_pr42",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(removed).toBe(false);
    expect(droppedDbs).toEqual([]);
    const rows = await testDb.db.select().from(previews);
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.dbName).toBe("prev_widgets_pr42");
  });

  test("aborts stale TTL plan after same-slug redeploy refreshed createdAt", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    // Same dbName as the plan, but generation clock was reset by redeploy.
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "widgets",
      dbName: "prev_widgets_pr42",
      hostname: "pr-42.example.com",
      containerId: null,
      status: "running",
      createdAt: "2026-09-03T11:55:00.000Z",
      updatedAt: "2026-09-03T11:55:00.000Z",
    });

    const droppedDbs: string[] = [];
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: { listOpenPrIds: async () => [42] },
      ttlHours: 72,
    });

    const removed = await ports.drop({
      reason: "sweep:ttl-expired",
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "widgets",
      dbName: "prev_widgets_pr42",
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(removed).toBe(false);
    expect(droppedDbs).toEqual([]);
    const rows = await testDb.db.select().from(previews);
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.createdAt).toBe("2026-09-03T11:55:00.000Z");
  });

  test("pr-not-open rechecks forge before lock and skips when PR reopened", async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "widgets",
      dbName: "prev_widgets_pr42",
      hostname: "pr-42.example.com",
      containerId: null,
      status: "running",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });

    const droppedDbs: string[] = [];
    let forgeCalls = 0;
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: {
        listOpenPrIds: async () => {
          forgeCalls += 1;
          return [42];
        },
      },
      ttlHours: 72,
    });

    const removed = await ports.drop({
      reason: "sweep:pr-not-open",
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "widgets",
      dbName: "prev_widgets_pr42",
      createdAt: "2026-09-02T12:00:00.000Z",
    });
    expect(removed).toBe(false);
    expect(forgeCalls).toBe(1);
    expect(droppedDbs).toEqual([]);
  });

  test("orphan drop aborts when a live row claims the dbName", async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    await testDb.db.insert(repos).values({
      canonicalId: "https://github.com/acme/widgets",
      slug: "widgets",
    });
    await testDb.db.insert(previews).values({
      canonicalRepoId: "https://github.com/acme/widgets",
      prId: 42,
      slug: "widgets",
      dbName: "prev_widgets_pr42",
      hostname: "pr-42.example.com",
      containerId: null,
      status: "provisioning",
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
    });

    const droppedDbs: string[] = [];
    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
        dropDatabase: async (dbName) => {
          droppedDbs.push(dbName);
        },
      }),
      forge: { listOpenPrIds: async () => [42] },
      ttlHours: 72,
    });

    const removed = await ports.drop({
      reason: "sweep:orphan-db",
      slug: "widgets",
      prId: 42,
      dbName: "prev_widgets_pr42",
    });
    expect(removed).toBe(false);
    expect(droppedDbs).toEqual([]);
  });

  test("throws on orphan teardown when a resource step fails", async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;

    const docker = createFakeDockerClient();
    const ports = createLiveSweepPorts({
      db: testDb.db,
      app: bindTestPreviewApp(docker),
      previewDb: stubPreviewDb({
        listPreviewDatabases: async () => [],
        dropDatabase: async () => {
          throw new Error("postgres busy");
        },
      }),
      forge: { listOpenPrIds: async () => [] },
      ttlHours: 72,
      log: () => {},
    });

    await expect(
      ports.drop({
        reason: "sweep:orphan-db",
        prId: 42,
        slug: "widgets",
        dbName: "prev_widgets_pr42",
      }),
    ).rejects.toThrow("teardown incomplete: prev_widgets_pr42");
  });
});
