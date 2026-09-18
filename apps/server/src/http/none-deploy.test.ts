import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { createFakePreviewDb } from "../preview-db/fake.ts";
import { createRoutingPreviewDb } from "../preview-db/routing.ts";
import type { PreviewDbRouter } from "../preview-db/routing.ts";
import { createSqlitePreviewDb } from "../preview-db/sqlite.ts";
import {
  bearer,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

let testApp: TestApp | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakeDocker = undefined;
});

/**
 * The deploy path for none must never touch the PreviewDb port: any
 * forCreate/forDrop call throws, so a passing bring-up/teardown proves
 * zero Postgres (or SQLite) calls without relying on review.
 */
function createThrowingPreviewDb(): PreviewDbRouter {
  const touched = () => {
    throw new Error("PreviewDb touched on the none deploy path");
  };
  return {
    forCreate: touched,
    forDrop: () => ({
      dropDatabase: async () => {
        throw new Error("PreviewDb touched on the none deploy path");
      },
    }),
    listPreviewDatabases: async () => [],
    ensurePreviewRole: async () => {},
    ping: async () => {},
  };
}

async function setupNoneOnly(previewDb?: PreviewDbRouter) {
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
  });
  testApp = await createTestApp({
    previewDb: previewDb ?? createThrowingPreviewDb(),
    docker: fakeDocker,
    postgres: undefined,
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  return postDeployAndSettle(testApp!, token, body);
}

async function teardown(token: string, prId = 42) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/teardown", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ canonical_repo_id: REPO, pr_id: prId }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

async function previewRow() {
  const [row] = await testApp!.db
    .select()
    .from(previews)
    .where(and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)))
    .limit(1);
  return row;
}

describe("none previews", () => {
  test("deploy runs with no env, no volumes, traefik only, null db_name", async () => {
    const { deployToken } = await setupNoneOnly();
    const res = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "none" } }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.outcome).toBe("ready");
    expect(res.body).toMatchObject({ db_name: null, status: "running" });

    const created = fakeDocker!.creates[0]!;
    expect(created.name).toBe("sprout-myapp-pr-42");
    expect(created.env).toEqual([]);
    expect(created.volumes ?? []).toEqual([]);
    expect(created.networkNames).toEqual(["sprout-traefik"]);

    const row = await previewRow();
    expect(row?.dbName).toBeNull();
    expect(row?.dbProvider).toBe("none");
    expect(fakeDocker!.volumesCreated).toEqual([]);
  });

  test("teardown removes containers without touching the PreviewDb port", async () => {
    const { deployToken } = await setupNoneOnly();
    const first = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "none" } }),
    );
    expect(first.outcome).toBe("ready");

    const torn = await teardown(deployToken);
    expect(torn.status).toBe(200);
    expect((await previewRow())?.status).toBe("removed");
    expect(fakeDocker!.volumesRemoved).toEqual([]);
  });

  test("list shows the row with a null database", async () => {
    const { deployToken } = await setupNoneOnly();
    await postDeploy(deployToken, deployBody({ db: { provider: "none" } }));

    const res = await testApp!.app.handle(
      new Request("http://localhost/v1/previews", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previews).toEqual([
      {
        canonical_repo_id: REPO,
        pr_id: 42,
        slug: "myapp",
        db_name: null,
        hostname: "pr-42.myapp.preview.example.com",
        status: "running",
        created_at: expect.any(String),
      },
    ]);
  });

  test("companion services start with no database env", async () => {
    const { deployToken } = await setupNoneOnly();
    const res = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "none" },
        services: [{ name: "worker", image: "worker:latest" }],
      }),
    );
    expect(res.outcome).toBe("ready");
    const names = fakeDocker!.creates.map((c) => c.name);
    expect(names).toContain("sprout-myapp-pr-42-svc-worker");
    for (const created of fakeDocker!.creates) {
      expect(created.env).toEqual([]);
      expect(created.volumes ?? []).toEqual([]);
    }
  });

  test("seed image and reseed are rejected with a named error", async () => {
    const { deployToken } = await setupNoneOnly();
    const seeded = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "none" },
        health: { path: "/health", interval: "2s", timeout: "90s", expect: 200 },
        seed_image: "ghcr.io/org/seed:1",
      }),
    );
    expect(seeded.settleStatus).toBe(422);
    expect(seeded.body).toEqual({
      error: "seed_requires_database",
      detail:
        "seed requires db.provider postgres or sqlite (db.provider is none)",
    });

    const reseeded = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "none" },
        seed_image: "ghcr.io/org/seed:1",
        reseed: true,
      }),
    );
    expect(reseeded.settleStatus).toBe(422);
    expect(reseeded.body).toEqual({
      error: "seed_requires_database",
      detail:
        "seed requires db.provider postgres or sqlite (db.provider is none)",
    });
    expect(fakeDocker!.creates).toEqual([]);
  });

  test("database-key preview.env entries are rejected", async () => {
    const { deployToken } = await setupNoneOnly();
    const pg = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "none" },
        env: { PGHOST: "DATABASE_HOST" },
      }),
    );
    expect(pg.settleStatus).toBe(422);
    expect(pg.body).toEqual({
      error: "invalid_env_for_provider",
      detail: "preview.env.PGHOST requires db.provider postgres",
    });

    const sqlite = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "none" },
        env: { DATABASE_URL: "APP_DATABASE_URL" },
      }),
    );
    expect(sqlite.settleStatus).toBe(422);
    expect(sqlite.body).toEqual({
      error: "invalid_env_for_provider",
      detail: "preview.env.DATABASE_URL requires db.provider sqlite",
    });
    expect(fakeDocker!.creates).toEqual([]);
  });

  test("postgres-to-none switch drops the old database, then tears down cleanly", async () => {
    fakeDocker = createFakeDockerClient({
      exposedPorts: { [APP_IMAGE]: 3000 },
    });
    const postgres = createFakePreviewDb();
    testApp = await createTestApp({
      previewDb: createRoutingPreviewDb({
        postgres,
        sqlite: createSqlitePreviewDb(fakeDocker),
      }),
      docker: fakeDocker,
    });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const deployToken = body.token as string;

    const first = await postDeploy(deployToken, deployBody({}));
    expect(first.outcome).toBe("ready");
    expect(postgres.created).toEqual(["sprout_myapp_pr42"]);

    const second = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "none" } }),
    );
    expect(second.outcome).toBe("ready");
    expect(second.body).toMatchObject({ db_name: null });
    expect(postgres.dropped).toEqual(["sprout_myapp_pr42"]);
    expect((await previewRow())?.dbProvider).toBe("none");

    const torn = await teardown(deployToken);
    expect(torn.status).toBe(200);
    expect(postgres.dropped).toEqual(["sprout_myapp_pr42"]);
  });

  test("none-to-sqlite switch provisions the volume", async () => {
    fakeDocker = createFakeDockerClient({
      exposedPorts: { [APP_IMAGE]: 3000 },
    });
    testApp = await createTestApp({
      previewDb: createRoutingPreviewDb({
        sqlite: createSqlitePreviewDb(fakeDocker),
      }),
      docker: fakeDocker,
      postgres: undefined,
    });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const deployToken = body.token as string;

    const first = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "none" } }),
    );
    expect(first.outcome).toBe("ready");
    expect((await previewRow())?.dbName).toBeNull();

    const second = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "sqlite" } }),
    );
    expect(second.outcome).toBe("ready");
    expect(fakeDocker!.volumesCreated).toEqual(["sprout-myapp-pr-42-sqlite"]);
    expect((await previewRow())?.dbProvider).toBe("sqlite");
  });

  test("gateway boot matrix: none needs no Postgres env, postgres still fails fast", async () => {
    const { deployToken } = await setupNoneOnly();
    const none = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "none" } }),
    );
    expect(none.outcome).toBe("ready");

    const pg = await postDeploy(deployToken, deployBody({}));
    expect(pg.settleStatus).toBe(500);
    expect(pg.body).toEqual({
      error: "postgres_not_configured",
      detail: `repo ${REPO} declares db.provider postgres but the gateway has no Postgres configured: missing SPROUT_PREVIEW_POSTGRES_URL, SPROUT_PG_HOST, SPROUT_PG_USER, SPROUT_PG_PASSWORD, SPROUT_POSTGRES_NETWORK`,
    });
  });
});
