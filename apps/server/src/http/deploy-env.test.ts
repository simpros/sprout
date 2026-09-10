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

async function setup() {
  fakePreviewDb = createFakePreviewDb();
  fakeDocker = createFakeDockerClient({
    exposedPorts: { [APP_IMAGE]: 3000 },
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

describe("POST /v1/deploy connection env remap", () => {
  test("remaps connection env names on app container create", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        env: {
          PGHOST: "DATABASE_HOST",
          PGPORT: "DATABASE_PORT",
          PGUSER: "DATABASE_USER",
          PGPASSWORD: "DATABASE_PASSWORD",
          PGDATABASE: "DATABASE_NAME",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "DATABASE_HOST=postgres",
      "DATABASE_PORT=5432",
      "DATABASE_USER=sprout_preview",
      "DATABASE_PASSWORD=preview-secret",
      "DATABASE_NAME=sprout_myapp_pr42",
    ]);
    // Remap is request-scoped — not written to SQLite.
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row).toMatchObject({
      slug: "myapp",
      dbName: "sprout_myapp_pr42",
      status: "running",
    });
  });

  test("rejects invalid env remap on deploy body", async () => {
    const { deployToken } = await setup();
    const unknown = await postDeploy(
      deployToken,
      deployBody({ env: { DATABASE_URL: "DATABASE_URL" } }),
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body).toEqual({ error: "unknown_env_key" });

    const collision = await postDeploy(
      deployToken,
      deployBody({
        env: { PGHOST: "DATABASE_HOST", PGPORT: "DATABASE_HOST" },
      }),
    );
    expect(collision.status).toBe(422);
    expect(collision.body).toEqual({ error: "env_target_collision" });

    const invalid = await postDeploy(
      deployToken,
      deployBody({ env: { PGHOST: "bad-name" } }),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ error: "invalid_env_target" });

    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });
});

describe("POST /v1/deploy app_env", () => {
  test("injects app_env with colliding connection keys stripped", async () => {
    const { deployToken } = await setup();
    const res = await postDeploy(
      deployToken,
      deployBody({
        app_env: [
          "BETTER_AUTH_SECRET=sekrit",
          "PGHOST=attacker",
          "APP_URL=https://pr-42.example.com",
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(fakeDocker!.creates[0]!.env).toEqual([
      "BETTER_AUTH_SECRET=sekrit",
      "APP_URL=https://pr-42.example.com",
      "PGHOST=postgres",
      "PGPORT=5432",
      "PGUSER=sprout_preview",
      "PGPASSWORD=preview-secret",
      "PGDATABASE=sprout_myapp_pr42",
    ]);
    const [row] = await testApp!.db
      .select()
      .from(previews)
      .where(
        and(eq(previews.canonicalRepoId, REPO), eq(previews.prId, 42)),
      )
      .limit(1);
    expect(row).toMatchObject({ status: "running", slug: "myapp" });
  });

  test("rejects invalid and oversized app_env", async () => {
    const { deployToken } = await setup();
    const invalid = await postDeploy(
      deployToken,
      deployBody({ app_env: ["=novalue", "OK=1"] }),
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ error: "invalid_app_env" });

    const tooMany = await postDeploy(
      deployToken,
      deployBody({
        app_env: Array.from({ length: 33 }, (_, i) => `K${i}=v`),
      }),
    );
    expect(tooMany.status).toBe(422);
    expect(tooMany.body).toEqual({ error: "too_many_app_env" });

    expect(fakePreviewDb!.created).toEqual([]);
    expect(fakeDocker!.creates).toEqual([]);
  });
});
