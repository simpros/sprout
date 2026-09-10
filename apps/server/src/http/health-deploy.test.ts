import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

/** Second network on create — fake assigns sequential IPs per attached network. */
const POSTGRES_IP = "10.99.0.2";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;
let healthHits: string[];

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
  healthHits = [];
});

async function setup(options?: {
  healthProbe?: HealthProbe;
  healthClock?: { now(): number; sleep(ms: number): Promise<void> };
}) {
  healthHits = [];
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
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
    healthProbe,
    healthClock: options?.healthClock,
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

async function postDeployRaw(token: string, body: Record<string, unknown>) {
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
  test("returns 202 provisioning before pull and health complete", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deployToken } = await setup({
      healthProbe: {
        async getStatus(url) {
          healthHits.push(url);
          await gate;
          return 200;
        },
      },
    });
    const early = await postDeployRaw(deployToken, deployBody());
    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({
      ok: true,
      status: "provisioning",
      hostname: "pr-42.myapp.preview.example.com",
    });
    expect((early.body as { preview_url?: string }).preview_url).toBeUndefined();
    // Health must not have completed before 202 (pull/replace may still be racing).
    expect(healthHits.length).toBe(0);

    release();

    let settled: { status: number; body: unknown } | undefined;
    for (let i = 0; i < 200; i++) {
      const poll = await testApp!.app.handle(
        new Request(
          `http://localhost/v1/preview?canonical_repo_id=${encodeURIComponent(REPO)}&pr_id=42`,
          { headers: bearer(deployToken) },
        ),
      );
      const pollBody = await poll.json();
      if (poll.status === 200 && pollBody.status === "running") {
        settled = { status: poll.status, body: pollBody };
        break;
      }
      if (poll.status >= 400) {
        settled = { status: poll.status, body: pollBody };
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(settled?.status).toBe(200);
    expect(settled?.body).toMatchObject({
      status: "running",
      preview_url: "https://pr-42.myapp.preview.example.com",
    });
  });

  test("blocks until healthy and returns running with preview_url", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      db_name: "sprout_myapp_pr42",
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
    expect(healthHits[0]).toBe(`http://${POSTGRES_IP}:3000/health`);
  });

  test("polls container IP on postgres network, not Traefik hostname", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    expect(healthHits.length).toBeGreaterThan(0);
    for (const url of healthHits) {
      expect(url.startsWith(`http://${POSTGRES_IP}:`)).toBe(true);
      expect(url.includes("pr-42.myapp.preview.example.com")).toBe(false);
      expect(url.startsWith("http://10.99.0.1:")).toBe(false); // traefik IP
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
    expect(res.settleStatus).toBe(200);
    expect(healthHits[0]).toBe(`http://${POSTGRES_IP}:3000/readyz`);
  });

  test("health timeout removes container, marks failed, logs health:timeout", async () => {
    let now = 0;
    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args);
    });
    try {
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
      expect(res.settleStatus).toBe(500);
      expect(res.body).toEqual({ error: "health_timeout" });

      const [row] = await testApp!.db
        .select()
        .from(previews)
        .where(
          and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
        )
        .limit(1);
      expect(row?.status).toBe("failed");
      expect(row?.containerId).toBeNull();
      expect(fakeDocker!.removed).toContain("sprout-myapp-pr-42");
      expect(warns.some((args) => args.includes("health:timeout"))).toBe(true);
      expect(healthHits.length).toBeGreaterThan(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("list maps starting to provisioning", async () => {
    await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 7,
      slug: "myapp",
      dbName: "sprout_myapp_pr7",
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
        db_name: "sprout_myapp_pr7",
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
      dbName: "sprout_myapp_pr8",
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
