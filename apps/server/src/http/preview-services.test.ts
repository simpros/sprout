import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
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

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  setSystemTime();
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
});

async function setup(options?: {
  exposedPorts?: Record<string, number | null>;
}) {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: options?.exposedPorts ?? { [APP_IMAGE]: 3000 },
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

function teardownBody(overrides: Record<string, unknown> = {}) {
  return {
    canonical_repo_id: REPO,
    pr_id: 42,
    ...overrides,
  };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  return postDeployAndSettle(testApp!, token, body);
}

async function postTeardown(token: string, body: Record<string, unknown>) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/teardown", {
      method: "POST",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/deploy services", () => {
  test("deploys app + service sharing PGDATABASE; teardown removes all", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000, [SVC]: 4000 },
    });
    const res = await postDeploy(
      deployToken,
      deployBody({
        services: [
          {
            name: "api",
            image: SVC,
            hostname: "api-pr-42.myapp.preview.example.com",
          },
        ],
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });
    expect(fakeDocker!.creates.map((c) => c.name)).toEqual([
      "sprout-myapp-pr-42",
      "sprout-myapp-pr-42-svc-api",
    ]);
    expect(fakeDocker!.creates[1]!.env).toContain(
      "PGDATABASE=sprout_myapp_pr42",
    );
    expect(fakeDocker!.creates[1]!.networkNames).toEqual([
      "sprout-traefik",
      "sprout-postgres",
    ]);
    // Health only probed the app (first create); service starts after healthy.
    expect(fakeDocker!.creates[0]!.name).toBe("sprout-myapp-pr-42");

    const teardown = await postTeardown(deployToken, teardownBody());
    expect(teardown.status).toBe(200);
    expect(fakeDocker!.removed).toEqual(
      expect.arrayContaining([
        "sprout-myapp-pr-42",
        "sprout-myapp-pr-42-svc-api",
      ]),
    );
    expect(fakeDocker!.running.size).toBe(0);
  });

  test("rejects invalid service names before SQL", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        services: [{ name: "Bad_Name", image: "img:1" }],
      }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({ error: "invalid_service_name" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("companion deploy failure keeps healthy app containerId", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000, [SVC]: 4000 },
    });
    const orig = fakeDocker!.createAndStart.bind(fakeDocker!);
    fakeDocker!.createAndStart = async (spec) => {
      if (spec.name.includes("-svc-")) throw new Error("svc boom");
      return orig(spec);
    };

    const res = await postDeploy(
      deployToken,
      deployBody({
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "failed",
      last_error: "preview_service_deploy_failed",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("preview_service_deploy_failed");
    expect(row?.failureFamily).toBe("post_healthy");
    expect(row?.containerId).toBe("fake-1");
    expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
    expect(fakeDocker!.running.has("sprout-myapp-pr-42-svc-api")).toBe(false);

    // Retry same app+services: sync-only (keep containerId), not seed-resume
    // and not full app replace.
    fakeDocker!.createAndStart = orig;
    const createsBeforeRetry = fakeDocker!.creates.length;
    const retry = await postDeploy(
      deployToken,
      deployBody({
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(retry.settleStatus).toBe(200);
    expect(retry.body).toMatchObject({ status: "running" });
    expect(retry.body).not.toHaveProperty(
      "last_error",
      "seed_image_required_to_resume_seeding",
    );
    expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
    expect(fakeDocker!.running.has("sprout-myapp-pr-42-svc-api")).toBe(true);

    const [after] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    expect(after?.containerId).toBe("fake-1");
    expect(after?.failureFamily).toBeNull();
    // Sync-only: one service create, no second app container.
    expect(
      fakeDocker!.creates.slice(createsBeforeRetry).map((c) => c.name),
    ).toEqual(["sprout-myapp-pr-42-svc-api"]);
  });

  test("post_healthy retry without services stays failed (no false running)", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000, [SVC]: 4000 },
    });
    const orig = fakeDocker!.createAndStart.bind(fakeDocker!);
    fakeDocker!.createAndStart = async (spec) => {
      if (spec.name.includes("-svc-")) throw new Error("svc boom");
      return orig(spec);
    };

    const failed = await postDeploy(
      deployToken,
      deployBody({
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(failed.outcome).toBe("failed");
    expect(failed.body).toMatchObject({
      last_error: "preview_service_deploy_failed",
    });

    fakeDocker!.createAndStart = orig;
    const createsBefore = fakeDocker!.creates.length;
    const retry = await postDeploy(
      deployToken,
      deployBody({}), // omit services — must not clear sticky fail
    );
    expect(retry.outcome).toBe("failed");
    expect(retry.body).toMatchObject({
      status: "failed",
      last_error: "services_required_after_companion_failure",
    });
    expect(fakeDocker!.creates.slice(createsBefore)).toEqual([]);
    expect(fakeDocker!.running.has("sprout-myapp-pr-42")).toBe(true);
    expect(fakeDocker!.running.has("sprout-myapp-pr-42-svc-api")).toBe(false);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    expect(row?.failureFamily).toBe("post_healthy");
    expect(row?.containerId).toBe("fake-1");
    expect(row?.status).toBe("failed");
  });

  test("crash after seed before sync resumes sync_close not re-seed", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const SEED = "ghcr.io/org/seed:sha";
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000, [SVC]: 4000, [SEED]: 80 },
    });
    // Simulate gateway kill after seed success, before companion sync.
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "seeding",
      appImage: APP_IMAGE,
      containerId: "fake-stuck",
      seededAt: new Date().toISOString(),
      bringUpPlan: "sync_close",
    });

    const createsBefore = fakeDocker!.creates.length;
    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED,
        health: {
          path: "/health",
          interval: "1s",
          timeout: "30s",
          expect: 200,
        },
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });
    // Must not re-seed or replace app — only sync companions then close.
    expect(
      fakeDocker!.creates.slice(createsBefore).map((c) => c.name),
    ).toEqual(["sprout-myapp-pr-42-svc-api"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    expect(row?.status).toBe("running");
    expect(row?.containerId).toBe("fake-stuck");
    expect(row?.bringUpPlan).toBeNull();
    expect(row?.seededAt).not.toBeNull();
  });

  test("crash after healthy promote (no seed) resumes sync_close not replace", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000, [SVC]: 4000 },
    });
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "starting",
      appImage: APP_IMAGE,
      containerId: "fake-stuck",
      bringUpPlan: "sync_close",
    });

    const createsBefore = fakeDocker!.creates.length;
    const res = await postDeploy(
      deployToken,
      deployBody({
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });
    expect(
      fakeDocker!.creates.slice(createsBefore).map((c) => c.name),
    ).toEqual(["sprout-myapp-pr-42-svc-api"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    expect(row?.containerId).toBe("fake-stuck");
    expect(row?.bringUpPlan).toBeNull();
  });

  test("seed runs before companion services on first deploy", async () => {
    const SVC = "ghcr.io/org/api:sha";
    const SEED = "ghcr.io/org/seed:sha";
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000, [SVC]: 4000, [SEED]: 80 },
    });
    const res = await postDeploy(
      deployToken,
      deployBody({
        seed_image: SEED,
        health: {
          path: "/health",
          interval: "1s",
          timeout: "30s",
          expect: 200,
        },
        services: [{ name: "api", image: SVC }],
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });
    const names = fakeDocker!.creates.map((c) => c.name);
    expect(names).toEqual([
      "sprout-myapp-pr-42",
      "sprout-myapp-pr-42-seed",
      "sprout-myapp-pr-42-svc-api",
    ]);
  });
});
