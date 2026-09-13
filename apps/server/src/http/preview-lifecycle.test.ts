import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  deriveRestrictedPassword,
  restrictedRoleName,
} from "@sprout/preview-db";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { parseUnambiguousUtcMs } from "../infrastructure/db/instant.ts";
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

const OTHER_REPO = "https://github.com/org/other";
const DB = "sprout_myapp_pr42";

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
  createDatabase?: (dbName: string) => Promise<void>;
  dropDatabase?: (dbName: string) => Promise<void>;
  exposedPorts?: Record<string, number | null>;
}) {
  fakePreviewDb = createFakePreviewDb();
  if (options?.createDatabase) {
    fakePreviewDb.createDatabase = options.createDatabase;
  }
  if (options?.dropDatabase) {
    fakePreviewDb.dropDatabase = options.dropDatabase;
  }
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

describe("POST /v1/deploy", () => {
  test("rejects invalid slug before SQL", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ slug: "bad_slug!" }),
    );
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({ error: "invalid_slug" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("rejects invalid pr_id before SQL", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(deployToken, deployBody({ pr_id: 0 }));
    expect(res.settleStatus).toBe(422);
    expect(res.body).toEqual({ error: "invalid_pr_id" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("rejects invalid hostname before SQL", async () => {
    const { deployToken } = await setup();
    for (const hostname of [
      "https://pr-42.example.com",
      "pr-42.example.com/preview",
      "-pr-42.example.com",
    ]) {
      const res = await postDeploy(deployToken, deployBody({ hostname }));
      expect(res.settleStatus).toBe(422);
      expect(res.body).toEqual({ error: "invalid_hostname" });
    }
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("trims hostname before validate and persist", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ hostname: "  pr-42.myapp.preview.example.com  " }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({
      hostname: "pr-42.myapp.preview.example.com",
      preview_url: "https://pr-42.myapp.preview.example.com",
    });
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      );
    expect(row?.hostname).toBe("pr-42.myapp.preview.example.com");
  });

  test("creates preview database and SQLite row", async () => {
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
    expect(fakePreviewDb!.created).toEqual(["sprout_myapp_pr42"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row).toMatchObject({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "running",
      appImage: APP_IMAGE,
      containerId: "fake-1",
    });
    expect(row!.updatedAt).toMatch(/Z$/);
    expect(parseUnambiguousUtcMs(row!.updatedAt)).not.toBeNull();
    expect(fakeDocker!.creates).toHaveLength(1);
    expect(fakeDocker!.creates[0]).toMatchObject({
      name: "sprout-myapp-pr-42",
      image: APP_IMAGE,
      env: [
        "PGHOST=postgres",
        "PGPORT=5432",
        "PGUSER=sprout_preview",
        "PGPASSWORD=preview-secret",
        "PGDATABASE=sprout_myapp_pr42",
        `PGAPPUSER=${restrictedRoleName(DB)}`,
        `PGAPPPASSWORD=${deriveRestrictedPassword("preview-secret", DB)}`,
      ],
      networkNames: ["sprout-traefik", "sprout-postgres"],
    });
    expect(fakeDocker!.creates[0]!.labels).toEqual({
      "traefik.enable": "true",
      "traefik.http.routers.sprout-myapp-pr-42.rule":
        "Host(`pr-42.myapp.preview.example.com`)",
      "traefik.http.services.sprout-myapp-pr-42.loadbalancer.server.port": "3000",
    });
  });

  test("deploy token cannot deploy for a different canonical repo", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({ canonical_repo_id: OTHER_REPO }),
    );
    expect(res.settleStatus).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("re-deploy replaces app container and keeps database", async () => {
    const { deployToken } = await setup({
      exposedPorts: {
        [APP_IMAGE]: 3000,
        "ghcr.io/org/myapp:sha-def": 3000,
      },
    });
    await postDeploy(deployToken, deployBody());
    const res = await postDeploy(
      deployToken,
      deployBody({
        app_image: "ghcr.io/org/myapp:sha-def",
        hostname: "pr-42.myapp.preview.example.com",
      }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({
      slug: "myapp",
      db_name: "sprout_myapp_pr42",
      status: "running",
    });
    expect(fakePreviewDb!.created).toEqual(["sprout_myapp_pr42"]);
    expect(fakeDocker!.creates.map((c) => c.image)).toEqual([
      APP_IMAGE,
      "ghcr.io/org/myapp:sha-def",
    ]);
    expect(fakeDocker!.removed.filter((n) => n === "sprout-myapp-pr-42")).toEqual([
      "sprout-myapp-pr-42",
      "sprout-myapp-pr-42",
    ]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.appImage).toBe("ghcr.io/org/myapp:sha-def");
    expect(row?.containerId).toBe("fake-2");
  });

  test("pull preflight failure does not poison a ready preview", async () => {
    const { deployToken } = await setup({
      exposedPorts: {
        [APP_IMAGE]: 3000,
        "ghcr.io/org/myapp:bad": 3000,
      },
    });
    await postDeploy(deployToken, deployBody());
    fakeDocker!.pullImage = async () => {
      throw new Error("registry blip");
    };
    const res = await postDeploy(
      deployToken,
      deployBody({ app_image: "ghcr.io/org/myapp:bad" }),
    );
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "running",
      last_error: "preview_app_pull_failed",
      last_error_detail: "registry blip",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
    expect(row?.appImage).toBe(APP_IMAGE);
    expect(row?.containerId).toBe("fake-1");
    expect(row?.lastError).toBe("preview_app_pull_failed");

    // GET and list agree on phase; sticky error is a snapshot field, not a 500.
    const statusRes = await testApp!.app.handle(
      new Request(
        `http://localhost/v1/preview?canonical_repo_id=${encodeURIComponent(REPO)}&pr_id=42`,
        { headers: bearer(deployToken) },
      ),
    );
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({
      status: "running",
      last_error: "preview_app_pull_failed",
      last_error_detail: "registry blip",
      preview_url: "https://pr-42.myapp.preview.example.com",
    });
    const listRes = await testApp!.app.handle(
      new Request("http://localhost/v1/previews", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      previews: Array<{ pr_id: number; status: string }>;
    };
    expect(listed.previews.find((p) => p.pr_id === 42)?.status).toBe("running");
  });

  test("registry pull failure returns stable error + detail", async () => {
    const { deployToken } = await setup({
      exposedPorts: { [APP_IMAGE]: 3000 },
    });
    fakeDocker!.pullImage = async () => {
      throw new Error(
        "Docker pull registry.example/private:1 failed: access forbidden",
      );
    };
    const res = await postDeploy(deployToken, deployBody());
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      last_error: "preview_app_pull_failed",
      last_error_detail: "access forbidden",
    });
  });

  test("retries createDatabase when stuck in provisioning with no DB", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
    });
    expect(fakePreviewDb!.created).toEqual([]);

    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({
      db_name: "sprout_myapp_pr42",
      status: "running",
    });
    expect(fakePreviewDb!.created).toEqual(["sprout_myapp_pr42"]);
  });

  test("stuck provisioning → ready refreshes createdAt generation", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });

    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row!.createdAt).not.toBe("2026-08-01T12:00:00.000Z");
    expect(row!.createdAt).toMatch(/Z$/);
    expect(parseUnambiguousUtcMs(row!.createdAt)).not.toBeNull();
    const ageMs =
      Date.now() - parseUnambiguousUtcMs(row!.createdAt)!;
    expect(ageMs).toBeLessThan(72 * 60 * 60 * 1000);
  });

  test("stuck starting → ready keeps createdAt generation", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "starting",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });

    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row!.createdAt).toBe("2026-08-01T12:00:00.000Z");
  });

  test("recreates database after teardown", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    await postTeardown(deployToken, teardownBody());
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(fakePreviewDb!.created).toEqual([
      "sprout_myapp_pr42",
      "sprout_myapp_pr42",
    ]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
  });

  test("marks error when createDatabase fails after SQLite write", async () => {
    const { deployToken } = await setup({
      createDatabase: async () => {
        throw new Error("boom");
      },
    });
    const res = await postDeploy(deployToken, deployBody());
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "failed",
      last_error: "preview_db_create_failed",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("failed");
  });

  test("retries provision after previous create failure", async () => {
    let failOnce = true;
    const { deployToken } = await setup({
      createDatabase: async (dbName) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("boom");
        }
        fakePreviewDb!.created.push(dbName);
      },
    });
    expect((await postDeploy(deployToken, deployBody())).outcome).toBe("failed");
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });
    expect(fakePreviewDb!.created).toEqual(["sprout_myapp_pr42"]);
  });

  test("parallel first deploys do not 500", async () => {
    const { deployToken } = await setup();
    const body = deployBody();
    const [a, b] = await Promise.all([
      postDeploy(deployToken, body),
      postDeploy(deployToken, body),
    ]);
    expect(a.settleStatus).toBe(200);
    expect(b.settleStatus).toBe(200);
    expect(fakePreviewDb!.created.length).toBeGreaterThanOrEqual(1);
    expect(fakePreviewDb!.created.every((n) => n === "sprout_myapp_pr42")).toBe(
      true,
    );
  });

  test("deploy while removing returns 409", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "removing",
    });
    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(409);
    expect(res.body).toEqual({ error: "preview_teardown_in_progress" });
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("concurrent reprovision from error: one slug wins, other conflicts once ready", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "old",
      dbName: "sprout_old_pr42",
      hostname: "old.example.com",
      status: "failed",
    });
    const [a, b] = await Promise.all([
      postDeploy(deployToken, deployBody({ slug: "alpha" })),
      postDeploy(deployToken, deployBody({ slug: "beta" })),
    ]);
    const statuses = [a.settleStatus, b.settleStatus].sort();
    // One deploy is accepted; the other hits in-flight 409 at accept time.
    expect(statuses).toEqual([200, 409]);
    const winner = a.settleStatus === 200 ? a : b;
    const loser = a.settleStatus === 409 ? a : b;
    expect(loser.body).toEqual({ error: "preview_deploy_in_progress" });
    expect(winner.body).toMatchObject({ status: "running" });
    const names = new Set(fakePreviewDb!.created);
    expect(names.size).toBe(1);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(names.has(row!.dbName)).toBe(true);
    expect(row!.slug).toBe((winner.body as { slug: string }).slug);
  });

  test("redeploy from error with same identity keeps createdAt generation", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "failed",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });

    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({ status: "running" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row!.createdAt).toBe("2026-08-01T12:00:00.000Z");
  });

  test("redeploy from error with new identity refreshes createdAt generation", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "old",
      dbName: "sprout_old_pr42",
      hostname: "old.example.com",
      status: "failed",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });

    const res = await postDeploy(deployToken, deployBody());
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({
      status: "running",
      slug: "myapp",
      db_name: "sprout_myapp_pr42",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row!.createdAt).not.toBe("2026-08-01T12:00:00.000Z");
    expect(row!.createdAt).toMatch(/Z$/);
    expect(parseUnambiguousUtcMs(row!.createdAt)).not.toBeNull();
    const ageMs =
      Date.now() - parseUnambiguousUtcMs(row!.createdAt)!;
    expect(ageMs).toBeLessThan(72 * 60 * 60 * 1000);
  });

  test("failed ready-replace then same-identity recover keeps createdAt", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { deployToken } = await setup({
      exposedPorts: {
        [APP_IMAGE]: 3000,
        "ghcr.io/org/myapp:next": 3000,
      },
    });
    await postDeploy(deployToken, deployBody());
    const createdAtAfterReady = (
      await testApp!.db
        .select()
        .from(previews)
        .where(
          and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
        )
        .limit(1)
    )[0]!.createdAt;

    const originalCreate = fakeDocker!.createAndStart.bind(fakeDocker);
    fakeDocker!.createAndStart = async () => {
      throw new Error("engine blip");
    };
    const fail = await postDeploy(
      deployToken,
      deployBody({ app_image: "ghcr.io/org/myapp:next" }),
    );
    expect(fail.outcome).toBe("failed");
    expect(fail.body).toMatchObject({
      status: "failed",
      last_error: "preview_app_deploy_failed",
    });

    const [failedRow] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(failedRow!.status).toBe("failed");
    expect(failedRow!.containerId).toBeNull();
    expect(failedRow!.lastError).toBe("preview_app_deploy_failed");

    fakeDocker!.createAndStart = originalCreate;
    const ok = await postDeploy(
      deployToken,
      deployBody({ app_image: "ghcr.io/org/myapp:next" }),
    );
    expect(ok.settleStatus).toBe(200);
    expect(ok.body).toMatchObject({ status: "running" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row!.createdAt).toBe(createdAtAfterReady);
    expect(row!.status).toBe("running");
    expect(row!.appImage).toBe("ghcr.io/org/myapp:next");
  });

  test("ready redeploy with slug change returns identity conflict", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const res = await postDeploy(
      deployToken,
      deployBody({
        slug: "other",
        hostname: "pr-42.other.preview.example.com",
      }),
    );
    expect(res.settleStatus).toBe(409);
    expect(res.body).toEqual({ error: "preview_identity_conflict" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.slug).toBe("myapp");
    expect(row?.dbName).toBe("sprout_myapp_pr42");
    expect(row?.status).toBe("running");
    expect(fakePreviewDb!.created).toEqual(["sprout_myapp_pr42"]);
  });

  test("provisioning resume with slug change returns identity conflict", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
    });
    const res = await postDeploy(
      deployToken,
      deployBody({
        slug: "other",
        hostname: "pr-42.other.preview.example.com",
      }),
    );
    expect(res.settleStatus).toBe(409);
    expect(res.body).toEqual({ error: "preview_identity_conflict" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.slug).toBe("myapp");
    expect(row?.dbName).toBe("sprout_myapp_pr42");
    expect(row?.status).toBe("provisioning");
    expect(row?.hostname).toBe("pr-42.myapp.preview.example.com");
    expect(fakePreviewDb!.created).toEqual([]);
  });

  test("ready redeploy with hostname-only change keeps slug/db generation", async () => {
    setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const createdAtAfterReady = (
      await testApp!.db
        .select()
        .from(previews)
        .where(
          and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
        )
        .limit(1)
    )[0]!.createdAt;

    const res = await postDeploy(
      deployToken,
      deployBody({ hostname: "pr-42.alt.preview.example.com" }),
    );
    expect(res.settleStatus).toBe(200);
    expect(res.body).toMatchObject({
      status: "running",
      slug: "myapp",
      db_name: "sprout_myapp_pr42",
      hostname: "pr-42.alt.preview.example.com",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row!.createdAt).toBe(createdAtAfterReady);
    expect(row!.hostname).toBe("pr-42.alt.preview.example.com");
  });

  test("slow create then teardown+redeploy leaves at most the winner db", async () => {
    let releaseCreate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseCreate = r;
    });
    let signalStarted!: () => void;
    const createStarted = new Promise<void>((r) => {
      signalStarted = r;
    });
    let createCalls = 0;
    const { deployToken } = await setup({
      createDatabase: async (dbName) => {
        createCalls += 1;
        if (createCalls === 1) {
          signalStarted();
          await gate;
        }
        fakePreviewDb!.created.push(dbName);
      },
    });

    const first = postDeploy(deployToken, deployBody({ slug: "alpha" }));
    await createStarted; // first deploy holds the per-preview lock inside CREATE
    const teardown = postTeardown(deployToken, teardownBody());
    const second = postDeploy(
      deployToken,
      deployBody({
        slug: "beta",
        hostname: "pr-42.beta.preview.example.com",
      }),
    );
    releaseCreate();

    const [a, t, b] = await Promise.all([first, teardown, second]);
    expect(a.settleStatus).toBe(200);
    expect(t.status).toBe(200);
    expect(b.settleStatus).toBe(200);
    expect(b.body).toMatchObject({
      slug: "beta",
      db_name: "sprout_beta_pr42",
      status: "running",
    });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.dbName).toBe("sprout_beta_pr42");
    expect(row?.status).toBe("running");

    // Winner's name must be present; alpha must have been dropped.
    expect(fakePreviewDb!.created).toContain("sprout_beta_pr42");
    expect(fakePreviewDb!.dropped).toContain("sprout_alpha_pr42");
    const live = new Set(fakePreviewDb!.created);
    for (const name of fakePreviewDb!.dropped) live.delete(name);
    expect([...live]).toEqual(["sprout_beta_pr42"]);
  });

  test("parallel deploys after ready do not CREATE again", async () => {
    const { deployToken } = await setup();
    const first = await postDeploy(deployToken, deployBody());
    expect(first.settleStatus).toBe(200);
    expect(first.body).toMatchObject({ status: "running" });

    const [a, b] = await Promise.all([
      postDeploy(deployToken, deployBody()),
      postDeploy(deployToken, deployBody()),
    ]);
    expect(a.settleStatus).toBe(200);
    expect(b.settleStatus).toBe(200);
    expect(fakePreviewDb!.created).toEqual(["sprout_myapp_pr42"]);
    expect(fakePreviewDb!.dropped).toEqual([]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("running");
    expect(row?.dbName).toBe("sprout_myapp_pr42");
  });

  test("stuck provisioning ensure failure persists failed + last_error", async () => {
    let calls = 0;
    const { deployToken } = await setup({
      createDatabase: async () => {
        calls += 1;
        throw new Error("transient");
      },
    });
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "provisioning",
    });
    const res = await postDeploy(deployToken, deployBody());
    expect(res.outcome).toBe("failed");
    expect(res.body).toMatchObject({
      status: "failed",
      last_error: "preview_db_create_failed",
    });
    expect(calls).toBe(1);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("preview_db_create_failed");
  });
});

describe("POST /v1/teardown", () => {
  test("drops database and sets status removed", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["sprout_myapp_pr42"]);

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("removed");
    expect(row!.updatedAt).toMatch(/Z$/);
    expect(parseUnambiguousUtcMs(row!.updatedAt)).not.toBeNull();
  });

  test("accepts body with only repo and pr_id", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    const res = await postTeardown(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
  });

  test("is idempotent when already removed", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, deployBody());
    await postTeardown(deployToken, teardownBody());
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["sprout_myapp_pr42"]);
  });

  test("is idempotent when preview never existed", async () => {
    const { deployToken } = await setup();
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual([]);
  });

  test("rejects invalid pr_id", async () => {
    const { deployToken } = await setup();
    const res = await postTeardown(deployToken, teardownBody({ pr_id: 0 }));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_pr_id" });
    expect(fakePreviewDb!.dropped).toEqual([]);
  });

  test("marks error when dropDatabase fails after removing", async () => {
    const { deployToken } = await setup({
      dropDatabase: async () => {
        throw new Error("boom");
      },
    });
    await postDeploy(deployToken, deployBody());
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "preview_db_drop_failed" });

    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("failed");
  });

  test("unknown status does not silently report removed", async () => {
    const { deployToken } = await setup();
    await testApp!.db.insert(previews).values({
      canonicalRepoId: REPO,
      prId: 42,
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      hostname: "pr-42.myapp.preview.example.com",
      status: "bogus",
    });
    const res = await postTeardown(deployToken, teardownBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "unknown_preview_status" });
    expect(fakePreviewDb!.dropped).toEqual([]);
  });
});
