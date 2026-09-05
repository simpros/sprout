import { afterEach, describe, expect, test } from "bun:test";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
import {
  bearer,
  createTestApp,
  postDeployToken,
  type TestApp,
} from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";

let testApp: TestApp | undefined;
let fakePreviewDb: FakePreviewDb | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  fakePreviewDb = undefined;
});

async function setup() {
  fakePreviewDb = createFakePreviewDb();
  testApp = await createTestApp({ previewDb: fakePreviewDb });
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

describe("GET /v1/previews", () => {
  test("admin lists provisioned previews with coarse status", async () => {
    const { deployToken } = await setup();
    const deployed = await postDeploy(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
    });
    expect(deployed.status).toBe(200);

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
        pr_id: 42,
        slug: "myapp",
        db_name: "prev_myapp_pr42",
        hostname: "pr-42.myapp.preview.example.com",
        status: "ready",
        created_at: expect.any(String),
      },
    ]);
  });
});

describe("GET /v1/doctor", () => {
  test("reports healthy when postgres is up and no orphans", async () => {
    await setup();
    const res = await testApp!.app.handle(
      new Request("http://localhost/v1/doctor", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      postgres: "ok",
      docker: "ok",
      orphans: [],
    });
  });

  test("returns API error shape when orphans exist", async () => {
    await setup();
    // Catalog DB with no SQLite row → orphan-db
    await fakePreviewDb!.createDatabase("prev_myapp_pr99");
    // Container with no SQLite row → orphan-container
    testApp!.containers.seed({
      containerId: "c-99",
      containerName: "pb-myapp-pr-99",
      slug: "myapp",
      prId: 99,
    });

    const res = await testApp!.app.handle(
      new Request("http://localhost/v1/doctor", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: "doctor_failed",
      postgres: "ok",
      docker: "ok",
      orphans: [
        {
          kind: "orphan-db",
          slug: "myapp",
          pr_id: 99,
          db_name: "prev_myapp_pr99",
        },
        {
          kind: "orphan-container",
          slug: "myapp",
          pr_id: 99,
        },
      ],
    });
  });

  test("returns API error shape when postgres ping fails", async () => {
    fakePreviewDb = createFakePreviewDb();
    fakePreviewDb.ping = async () => {
      throw new Error("connection refused");
    };
    testApp = await createTestApp({ previewDb: fakePreviewDb });

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/doctor", {
        headers: bearer(testApp.adminToken),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: "doctor_failed",
      postgres: "unreachable",
      docker: "ok",
      orphans: [],
    });
  });

  test("returns API error shape when docker is unreachable", async () => {
    await setup();
    testApp!.containers.listPreviewContainers = async () => {
      throw new Error("docker socket down");
    };

    const res = await testApp!.app.handle(
      new Request("http://localhost/v1/doctor", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: "doctor_failed",
      postgres: "ok",
      docker: "unreachable",
      orphans: [],
    });
  });
});

async function postDrop(body: Record<string, unknown>) {
  const res = await testApp!.app.handle(
    new Request("http://localhost/v1/drop", {
      method: "POST",
      headers: {
        ...bearer(testApp!.adminToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/drop", () => {
  test("without yes returns plan and does not destroy", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
    });
    testApp!.containers.seed({
      containerId: "c-42",
      containerName: "pb-myapp-pr-42",
      slug: "myapp",
      prId: 42,
    });

    const res = await postDrop({
      canonical_repo_id: REPO,
      pr_id: 42,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "confirmation_required",
      plan: {
        canonical_repo_id: REPO,
        pr_id: 42,
        slug: "myapp",
        db_name: "prev_myapp_pr42",
        hostname: "pr-42.myapp.preview.example.com",
        status: "ready",
      },
    });
    expect(fakePreviewDb!.dropped).toEqual([]);
    expect(testApp!.containers.removed).toEqual([]);
  });

  test("with yes removes database, container, and sqlite row", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
    });
    testApp!.containers.seed({
      containerId: "c-42",
      containerName: "pb-myapp-pr-42",
      slug: "myapp",
      prId: 42,
    });

    const res = await postDrop({
      canonical_repo_id: REPO,
      pr_id: 42,
      yes: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["prev_myapp_pr42"]);
    expect(testApp!.containers.removed).toEqual([{ slug: "myapp", prId: 42 }]);

    const list = await testApp!.app.handle(
      new Request("http://localhost/v1/previews", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(await list.json()).toEqual({ previews: [] });
  });

  test("container remove failure still returns ok; doctor sees orphan", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
    });
    testApp!.containers.seed({
      containerId: "c-42",
      containerName: "pb-myapp-pr-42",
      slug: "myapp",
      prId: 42,
    });
    testApp!.containers.remove = async () => {
      throw new Error("docker hung");
    };

    const res = await postDrop({
      canonical_repo_id: REPO,
      pr_id: 42,
      yes: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["prev_myapp_pr42"]);

    // Restore list so doctor can see the leftover container.
    testApp!.containers.remove = async () => {};
    const doctorRes = await testApp!.app.handle(
      new Request("http://localhost/v1/doctor", {
        headers: bearer(testApp!.adminToken),
      }),
    );
    expect(doctorRes.status).toBe(503);
    const doctorBody = await doctorRes.json();
    expect(doctorBody.orphans).toContainEqual({
      kind: "orphan-container",
      slug: "myapp",
      pr_id: 42,
    });
  });
});
