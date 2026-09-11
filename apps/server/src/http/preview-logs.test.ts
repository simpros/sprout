import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createFakeDockerClient,
  type FakeDockerClient,
} from "../docker/fake.ts";
import { previewContainerName } from "../preview/naming.ts";
import { previews } from "../infrastructure/db/schema.ts";
import {
  bearer,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  TEST_APP_IMAGE,
  type TestApp,
} from "./test-helpers.ts";
import { DEFAULT_LOG_TAIL, MAX_LOG_TAIL } from "./preview-logs.ts";

const OTHER_REPO = "https://github.com/org/other";
const SEED_IMAGE = "ghcr.io/org/seed:test";

describe("GET /v1/previews/:id/logs", () => {
  let testApp: TestApp;

  afterEach(async () => {
    await testApp?.cleanup();
  });

  async function setup(opts?: {
    waitResults?: Record<string, { exitCode: number } | "timeout">;
  }) {
    const docker = createFakeDockerClient({
      exposedPorts: { [TEST_APP_IMAGE]: 3000 },
      waitResults: opts?.waitResults,
    });
    testApp = await createTestApp({ docker });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
    return {
      deployToken: body.token as string,
      docker: testApp.docker as FakeDockerClient,
    };
  }

  async function getLogs(
    token: string,
    prId: number,
    query: Record<string, string> = {},
  ) {
    const qs = new URLSearchParams({
      canonical_repo_id: "https://github.com/org/repo",
      ...query,
    });
    const res = await testApp.app.handle(
      new Request(`http://localhost/v1/previews/${prId}/logs?${qs}`, {
        headers: bearer(token),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  test("returns live app logs and empty seed after a successful deploy", async () => {
    const { deployToken, docker } = await setup();
    const settled = await postDeployAndSettle(
      testApp,
      deployToken,
      deployBody(),
    );
    expect(settled.outcome).toBe("ready");

    docker.logs.set(previewContainerName("myapp", 42), "app line 1\napp line 2\n");

    const res = await getLogs(deployToken, 42, { tail: "50" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      canonical_repo_id: "https://github.com/org/repo",
      pr_id: 42,
      tail: 50,
      app: "app line 1\napp line 2\n",
      seed: "",
    });
  });

  test("returns stored seed logs after seed_failed", async () => {
    const { deployToken, docker } = await setup({
      waitResults: { "sprout-myapp-pr-42-seed": { exitCode: 7 } },
    });
    const originalCreate = docker.createAndStart.bind(docker);
    docker.createAndStart = async (spec) => {
      const created = await originalCreate(spec);
      if (spec.name.endsWith("-seed")) {
        docker.logs.set(spec.name, "seed boom\nseed line 2\n");
      }
      return created;
    };

    const settled = await postDeployAndSettle(
      testApp,
      deployToken,
      deployBody({
        seed_image: SEED_IMAGE,
        health: {
          path: "/health",
          interval: "1s",
          timeout: "5s",
          expect: 200,
        },
      }),
    );
    expect(settled.outcome).toBe("failed");
    expect(settled.body).toMatchObject({
      last_error: "seed_failed",
      last_error_detail: "exit=7",
    });

    docker.logs.set(previewContainerName("myapp", 42), "still-running-app\n");

    const res = await getLogs(deployToken, 42, { tail: "50" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      canonical_repo_id: "https://github.com/org/repo",
      pr_id: 42,
      tail: 50,
      app: "still-running-app\n",
      seed: "seed boom\nseed line 2\n",
    });
  });

  test("defaults tail and returns empty seed when no seed failure", async () => {
    const { deployToken, docker } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());
    docker.logs.set(previewContainerName("myapp", 42), "only-app\n");

    const res = await getLogs(deployToken, 42);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      tail: DEFAULT_LOG_TAIL,
      app: "only-app\n",
      seed: "",
    });
  });

  test("deploy token cannot read another repo's preview logs", async () => {
    const { deployToken } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());

    const qs = new URLSearchParams({ canonical_repo_id: OTHER_REPO });
    const res = await testApp.app.handle(
      new Request(`http://localhost/v1/previews/42/logs?${qs}`, {
        headers: bearer(deployToken),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("missing preview returns 404", async () => {
    const { deployToken } = await setup();
    const res = await getLogs(deployToken, 99);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "preview_not_found" });
  });

  test("removing preview returns 409 like GET /v1/preview", async () => {
    const { deployToken } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());
    await testApp.db
      .update(previews)
      .set({ status: "removing" })
      .where(
        and(
          eq(previews.canonicalRepoId, "https://github.com/org/repo"),
          eq(previews.prId, 42),
        ),
      );
    const res = await getLogs(deployToken, 42);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "preview_teardown_in_progress" });
  });

  test("caps oversized tail", async () => {
    const { deployToken } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());
    const res = await getLogs(deployToken, 42, {
      tail: String(MAX_LOG_TAIL + 500),
    });
    expect(res.status).toBe(200);
    expect(res.body.tail).toBe(MAX_LOG_TAIL);
  });

  test("unauthenticated request is 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request(
        "http://localhost/v1/previews/42/logs?canonical_repo_id=https://github.com/org/repo",
      ),
    );
    expect(res.status).toBe(401);
  });
});
