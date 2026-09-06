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
import type { HealthProbe } from "../app-deployment/health.ts";
import {
  bearer,
  createTestApp,
  postDeployToken,
  type TestApp,
} from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";
const APP_IMAGE = "ghcr.io/org/myapp:sha-abc";
const POSTGRES_NETWORK = "preview-buddy-postgres";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;
let healthHits: string[];
let logs: string[];

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
  healthHits = [];
  logs = [];
});

async function setup(options?: {
  healthProbe?: HealthProbe;
  healthClock?: { now(): number; sleep(ms: number): Promise<void> };
}) {
  healthHits = [];
  logs = [];
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
    postgresNetwork: POSTGRES_NETWORK,
  });
  const healthProbe: HealthProbe = options?.healthProbe ?? {
    async getStatus(url) {
      healthHits.push(url);
      return 200;
    },
  };
  testApp = await createTestApp({
    previewDb: fakePreviewDb,
    docker: fakeDocker,
    postgresNetwork: POSTGRES_NETWORK,
    healthProbe,
    healthClock: options?.healthClock,
    log: (message) => {
      logs.push(message);
    },
  });
  const { body } = await postDeployToken(testApp, {
    canonical_repo_id: REPO,
    slug: "myapp",
  });
  return { deployToken: body.token as string };
}

function deployBody(overrides: Record<string, unknown> = {}) {
  return {
    canonical_repo_id: REPO,
    pr_id: 42,
    slug: "myapp",
    hostname: "pr-42.myapp.preview.example.com",
    app_image: APP_IMAGE,
    ...overrides,
  };
}

async function postDeploy(token: string, body: Record<string, unknown>) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/deploy", {
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

describe("POST /v1/deploy health polling", () => {
  test("blocks until healthy and returns running with preview_url", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      db_name: "prev_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "running",
      preview_url: "https://pr-42.myapp.preview.example.com",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
    expect(healthHits[0]).toBe("http://10.99.0.1:3000/health");
  });

  test("polls container IP on postgres network, not Traefik hostname", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    expect(healthHits.length).toBeGreaterThan(0);
    for (const url of healthHits) {
      expect(url.startsWith("http://10.99.0.")).toBe(true);
      expect(url.includes("pr-42.myapp.preview.example.com")).toBe(false);
    }
  });

  test("honors custom health block from deploy request", async () => {
    const { deployToken } = await setup({
      healthProbe: {
        async getStatus(url) {
          healthHits.push(url);
          return 204;
        },
      },
    });
    const res = await postDeploy(
      deployToken,
      deployBody({
        health: {
          path: "/readyz",
          interval: "1s",
          timeout: "30s",
          expect: 204,
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(healthHits[0]).toBe("http://10.99.0.1:3000/readyz");
  });

  test("health timeout marks failed and logs health:timeout", async () => {
    let now = 0;
    const { deployToken } = await setup({
      healthProbe: {
        async getStatus(url) {
          healthHits.push(url);
          return 503;
        },
      },
      healthClock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    const res = await postDeploy(deployToken, deployBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "health_timeout" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("failed");
    expect(logs.some((m) => m.includes("health:timeout"))).toBe(true);
    expect(healthHits.length).toBeGreaterThan(1);
  });

  test("list maps starting to provisioning", async () => {
    await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 7,
      slug: "myapp",
      dbName: "prev_myapp_pr7",
      hostname: "pr-7.myapp.preview.example.com",
      status: "starting",
    });
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
        pr_id: 7,
        slug: "myapp",
        db_name: "prev_myapp_pr7",
        hostname: "pr-7.myapp.preview.example.com",
        status: "provisioning",
        created_at: expect.any(String),
      },
    ]);
  });

  test("list maps seeding to provisioning", async () => {
    await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 8,
      slug: "myapp",
      dbName: "prev_myapp_pr8",
      hostname: "pr-8.myapp.preview.example.com",
      status: "seeding",
    });
    const res = await testApp!.app.handle(
      new Request("http://localhost/v1/previews", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previews[0]?.status).toBe("provisioning");
  });
});
