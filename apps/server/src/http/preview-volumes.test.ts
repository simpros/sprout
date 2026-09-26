import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
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

const DATA_VOLUME = "sprout-myapp-pr-42-data-0";
const SEED_IMAGE = "ghcr.io/org/myapp-seed:sha-abc";
const SVC_IMAGE = "ghcr.io/org/api:sha";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
});

async function setup() {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000, [SVC_IMAGE]: 4000 },
  });
  testApp = await createTestApp({
    previewDb: fakePreviewDb,
    docker: fakeDocker,
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

async function postTeardown(token: string) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/teardown", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ canonical_repo_id: REPO, pr_id: 42 }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

function healthBlock() {
  return { path: "/health", interval: "1s", timeout: "30s", expect: 200 };
}

describe("POST /v1/deploy preview.volumes", () => {
  test("without the key no volume is created and containers carry no Binds", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.volumesCreated).toEqual([]);
    expect(fakeDocker!.creates[0]).not.toHaveProperty("volumes");
  });

  test("bring-up creates the volume and mounts it on app, service, and seed", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        volumes: ["/data/documents"],
        services: [{ name: "api", image: SVC_IMAGE }],
        seed_image: SEED_IMAGE,
        health: healthBlock(),
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(fakeDocker!.volumesCreated).toEqual([DATA_VOLUME]);
    const byName = new Map(fakeDocker!.creates.map((c) => [c.name, c]));
    expect(byName.get("sprout-myapp-pr-42")?.volumes).toEqual([
      `${DATA_VOLUME}:/data/documents`,
    ]);
    expect(byName.get("sprout-myapp-pr-42-svc-api")?.volumes).toEqual([
      `${DATA_VOLUME}:/data/documents`,
    ]);
    const seed = byName.get("sprout-myapp-pr-42-seed");
    expect(seed?.volumes).toEqual([`${DATA_VOLUME}:/data/documents`]);
  });

  test("replace keeps the volume: no removal between deploys", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(
      deployToken,
      deployBody({ volumes: ["/data/documents"] }),
    );
    expect(first.settleStatus).toBe(200);
    const second = await postDeploy(
      deployToken,
      deployBody({ volumes: ["/data/documents"] }),
    );
    expect(second.settleStatus).toBe(200);
    expect(fakeDocker!.volumesRemoved).toEqual([]);
    expect([...fakeDocker!.volumes]).toEqual([DATA_VOLUME]);
    const appCreates = fakeDocker!.creates.filter(
      (c) => c.name === "sprout-myapp-pr-42",
    );
    expect(appCreates).toHaveLength(2);
    for (const create of appCreates) {
      expect(create.volumes).toEqual([`${DATA_VOLUME}:/data/documents`]);
    }
  });

  test("teardown removes data volumes, including for failed previews", async () => {
    const { deployToken } = await setup();
    const deployed = await postDeploy(
      deployToken,
      deployBody({ volumes: ["/data/documents"] }),
    );
    expect(deployed.settleStatus).toBe(200);
    expect([...fakeDocker!.volumes]).toEqual([DATA_VOLUME]);
    await testApp!.db
      .update(previews)
      .set({ status: "failed", containerId: null })
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    const torn = await postTeardown(deployToken);
    expect(torn.status).toBe(200);
    expect(fakeDocker!.volumesRemoved).toEqual([DATA_VOLUME]);
    expect([...fakeDocker!.volumes]).toEqual([]);
  });

  test("reset (teardown then deploy) reuses the same volume name", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(
      deployToken,
      deployBody({ volumes: ["/data/documents"] }),
    );
    expect(first.settleStatus).toBe(200);
    const torn = await postTeardown(deployToken);
    expect(torn.status).toBe(200);
    expect(fakeDocker!.volumesRemoved).toEqual([DATA_VOLUME]);
    const second = await postDeploy(
      deployToken,
      deployBody({ volumes: ["/data/documents"] }),
    );
    expect(second.settleStatus).toBe(200);
    expect(fakeDocker!.volumesCreated).toEqual([DATA_VOLUME, DATA_VOLUME]);
    expect([...fakeDocker!.volumes]).toEqual([DATA_VOLUME]);
  });

  test("malformed entries fail with invalid_volumes naming preview.volumes", async () => {
    const { deployToken } = await setup();
    for (const volumes of [
      ["relative/path"],
      ["/data", "/data/"],
      ["/a/../b"],
    ]) {
      const res = await postDeploy(deployToken, deployBody({ volumes }));
      expect(res.settleStatus).toBe(422);
      expect(res.body).toMatchObject({ error: "invalid_volumes" });
      expect(String((res.body as { detail?: string }).detail ?? "")).toContain(
        "preview.volumes",
      );
    }
    const collision = await postDeploy(
      deployToken,
      deployBody({
        volumes: ["/data"],
        db: { provider: "sqlite", path: "/data", file: "preview.db" },
      }),
    );
    expect(collision.settleStatus).toBe(422);
    expect(collision.body).toMatchObject({ error: "invalid_volumes" });
    expect(
      String((collision.body as { detail?: string }).detail ?? ""),
    ).toContain("db.path");
    expect(fakeDocker!.creates).toEqual([]);
  });
});
