import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { createFakePreviewDb } from "../preview-db/fake.ts";
import { createRoutingPreviewDb } from "../preview-db/routing.ts";
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

async function setupSqliteOnly() {
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000, "ghcr.io/org/myapp:v2": 3000 },
  });
  testApp = await createTestApp({
    previewDb: createRoutingPreviewDb({
      sqlite: createSqlitePreviewDb(fakeDocker),
    }),
    docker: fakeDocker,
    postgresGate: {
      configured: false,
      detail: (repo) =>
        `repo ${repo} declares db.provider postgres but the gateway has no Postgres configured: missing SPROUT_PREVIEW_POSTGRES_URL`,
    },
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

describe("sqlite previews", () => {
  test("deploy provisions a volume and injects DATABASE_URL without PG* keys", async () => {
    const { deployToken } = await setupSqliteOnly();
    const res = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "sqlite" } }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.outcome).toBe("ready");

    expect(fakeDocker!.volumesCreated).toEqual(["sprout-myapp-pr-42-sqlite"]);

    const created = fakeDocker!.creates[0]!;
    expect(created.name).toBe("sprout-myapp-pr-42");
    expect(created.env).toEqual(["DATABASE_URL=file:/data/preview.db"]);
    expect(created.networkNames).toEqual(["sprout-traefik"]);
    expect(created.volumes).toEqual(["sprout-myapp-pr-42-sqlite:/data"]);
  });

  test("DATABASE_URL remap replaces the name with no dual alias", async () => {
    const { deployToken } = await setupSqliteOnly();
    const res = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "sqlite" },
        env: { DATABASE_URL: "APP_DATABASE_URL" },
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "APP_DATABASE_URL=file:/data/preview.db",
    ]);
  });

  test("app-image replace keeps the volume; teardown drops it", async () => {
    const { deployToken } = await setupSqliteOnly();
    const first = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "sqlite" } }),
    );
    expect(first.outcome).toBe("ready");

    const second = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "sqlite" },
        app_image: "ghcr.io/org/myapp:v2",
      }),
    );
    expect(second.outcome).toBe("ready");
    expect(fakeDocker!.creates).toHaveLength(2);
    expect(fakeDocker!.volumesRemoved).toEqual([]);
    expect([...(fakeDocker as FakeDockerClient).volumes]).toEqual([
      "sprout-myapp-pr-42-sqlite",
    ]);

    const torn = await teardown(deployToken);
    expect(torn.status).toBe(200);
    expect(fakeDocker!.volumesRemoved).toEqual(["sprout-myapp-pr-42-sqlite"]);
    expect([...fakeDocker!.volumes]).toEqual([]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("removed");
  });

  test("seed image gets the same volume and connection env", async () => {
    const { deployToken } = await setupSqliteOnly();
    const res = await postDeploy(
      deployToken,
      deployBody({
        db: { provider: "sqlite", path: "/sqlite", file: "app.db" },
        health: { path: "/health", interval: "2s", timeout: "90s", expect: 200 },
        seed_image: "ghcr.io/org/seed:1",
      }),
    );
    expect(res.outcome).toBe("ready");
    const seed = fakeDocker!.creates.find(
      (c) => c.name === "sprout-myapp-pr-42-seed",
    )!;
    expect(seed.env).toEqual(["DATABASE_URL=file:/sqlite/app.db"]);
    expect(seed.volumes).toEqual(["sprout-myapp-pr-42-sqlite:/sqlite"]);
    expect(seed.networkNames).toEqual(["sprout-traefik"]);
  });

  test("postgres deploy fails fast naming the repo on a sqlite-only gateway", async () => {
    const { deployToken } = await setupSqliteOnly();
    const res = await postDeploy(deployToken, deployBody({}));
    expect(res.settleStatus).toBe(500);
    expect(res.outcome).toBe("rejected");
    expect(res.body).toEqual({
      error: "postgres_not_configured",
      detail: `repo ${REPO} declares db.provider postgres but the gateway has no Postgres configured: missing SPROUT_PREVIEW_POSTGRES_URL`,
    });
    expect(fakeDocker!.creates).toEqual([]);
    expect(fakeDocker!.volumesCreated).toEqual([]);
  });

  test("provider switch drops the old backend and teardowns the stored one", async () => {
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

    const first = await postDeploy(
      deployToken,
      deployBody({ db: { provider: "sqlite" } }),
    );
    expect(first.outcome).toBe("ready");
    expect([...fakeDocker.volumes]).toEqual(["sprout-myapp-pr-42-sqlite"]);

    const second = await postDeploy(deployToken, deployBody({}));
    expect(second.outcome).toBe("ready");
    expect([...fakeDocker.volumes]).toEqual([]);
    expect(fakeDocker.volumesRemoved).toEqual(["sprout-myapp-pr-42-sqlite"]);
    expect(postgres.created).toEqual(["sprout_myapp_pr42"]);

    const row = async () =>
      (
        await testApp!.db
          .select()
          .from(previews)
          .where(
            and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
          )
          .limit(1)
      )[0];
    expect((await row())?.dbProvider).toBe("postgres");

    const torn = await teardown(deployToken);
    expect(torn.status).toBe(200);
    expect(postgres.dropped).toEqual(["sprout_myapp_pr42"]);
    expect(fakeDocker.volumesRemoved).toEqual(["sprout-myapp-pr-42-sqlite"]);
  });
});
