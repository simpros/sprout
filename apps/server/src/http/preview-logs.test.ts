import { afterEach, describe, expect, test } from "bun:test";
import {
  previewContainerName,
  seedImageRunName,
} from "../preview/naming.ts";
import {
  bearer,
  createTestApp,
  deployBody,
  postDeployAndSettle,
  postDeployToken,
  type TestApp,
} from "./test-helpers.ts";
import { DEFAULT_LOG_TAIL, MAX_LOG_TAIL } from "./preview-logs.ts";

const OTHER_REPO = "https://github.com/org/other";

describe("GET /v1/previews/:id/logs", () => {
  let testApp: TestApp;

  afterEach(async () => {
    await testApp?.cleanup();
  });

  async function setup() {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: "https://github.com/org/repo",
      slug: "myapp",
    });
    return { deployToken: body.token as string };
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

  test("returns app and seed logs for a deploy-token-scoped preview", async () => {
    const { deployToken } = await setup();
    const settled = await postDeployAndSettle(
      testApp,
      deployToken,
      deployBody(),
    );
    expect(settled.outcome).toBe("ready");

    const docker = testApp.docker as import("../docker/fake.ts").FakeDockerClient;
    const appName = previewContainerName("myapp", 42);
    docker.logs.set(appName, "app line 1\napp line 2\n");
    // Seed container is removed after deploy; leave one around to prove both paths.
    await docker.createAndStart({
      name: seedImageRunName("myapp", 42),
      image: "seed:test",
      env: [],
      labels: {},
      networkNames: ["sprout-postgres"],
    });
    docker.logs.set(seedImageRunName("myapp", 42), "seed boom\n");

    const res = await getLogs(deployToken, 42, { tail: "50" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      canonical_repo_id: "https://github.com/org/repo",
      pr_id: 42,
      tail: 50,
      app: "app line 1\napp line 2\n",
      seed: "seed boom\n",
    });
  });

  test("defaults tail and returns empty seed when seed container is gone", async () => {
    const { deployToken } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());
    const docker = testApp.docker as import("../docker/fake.ts").FakeDockerClient;
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

  test("caps oversized tail", async () => {
    const { deployToken } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());
    const res = await getLogs(deployToken, 42, {
      tail: String(MAX_LOG_TAIL + 500),
    });
    expect(res.status).toBe(200);
    expect(res.body.tail).toBe(MAX_LOG_TAIL);
  });

  test("follow=true is not supported yet", async () => {
    const { deployToken } = await setup();
    await postDeployAndSettle(testApp, deployToken, deployBody());
    const res = await getLogs(deployToken, 42, { follow: "true" });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "follow_not_supported" });
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
