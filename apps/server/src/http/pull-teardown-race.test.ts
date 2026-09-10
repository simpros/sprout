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
  postDeployToken,
  TEST_APP_IMAGE as APP_IMAGE,
  TEST_REPO as REPO,
  type TestApp,
} from "./test-helpers.ts";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;
let fakeDocker: FakeDockerClient | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
  fakeDocker = undefined;
});

/**
 * Pull-fail persistence must not resurrect a torn-down preview (round-6).
 * Gate the registry pull, teardown mid-flight, then let pull fail under lock.
 */
describe("deploy pull vs teardown race", () => {
  test("pull failure after teardown leaves row removed", async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((r) => {
      releasePull = r;
    });
    let signalPullStarted!: () => void;
    const pullStarted = new Promise<void>((r) => {
      signalPullStarted = r;
    });

    fakePreviewDb = createFakePreviewDb();
    fakeDocker = createFakeDockerClient({
      exposedPorts: { [APP_IMAGE]: 3000 },
    });
    fakeDocker.pullImage = async () => {
      signalPullStarted();
      await pullGate;
      throw new Error("registry blip after teardown");
    };
    testApp = await createTestApp({
      previewDb: fakePreviewDb,
      docker: fakeDocker,
    });
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const deployToken = body.token as string;

    const accept = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        method: "POST",
        headers: {
          ...bearer(deployToken),
          "content-type": "application/json",
        },
        body: JSON.stringify(deployBody()),
      }),
    );
    expect(accept.status).toBe(202);
    await pullStarted;

    const teardown = await testApp.app.handle(
      new Request("http://localhost/v1/teardown", {
        method: "POST",
        headers: {
          ...bearer(deployToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          pr_id: 42,
        }),
      }),
    );
    expect(teardown.status).toBe(200);

    releasePull();

    // Background runAsyncDeploy must finish (and not resurrect) before we assert.
    for (let i = 0; i < 200; i++) {
      const [row] = await testApp.db
        .select()
        .from(previews)
        .where(
          and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
        )
        .limit(1);
      if (!row || row.status === "removed") break;
      // Still provisioning: wait for locked pull-fail path to observe tombstone.
      if (row.status !== "provisioning" && row.status !== "removing") break;
      await new Promise<void>((r) => setImmediate(r));
    }

    const [row] = await testApp.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row?.status).toBe("removed");
    expect(row?.lastError).toBeNull();

    const statusRes = await testApp.app.handle(
      new Request(
        `http://localhost/v1/preview?canonical_repo_id=${encodeURIComponent(REPO)}&pr_id=42`,
        { headers: bearer(deployToken) },
      ),
    );
    expect(statusRes.status).toBe(404);
  });
});
