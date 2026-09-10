import { afterEach, describe, expect, test } from "bun:test";
import {
  createFakePreviewDb,
  type FakePreviewDb,
} from "../preview-db/fake.ts";
import { previewContainerName } from "../preview/naming.ts";
import type { FakeDockerClient } from "../docker/fake.ts";
import {
  bearer,
  createTestApp,
  postDeployAndSettle,
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

function fakeDocker(): FakeDockerClient {
  return testApp!.docker as FakeDockerClient;
}

/** Seed a catalog sprout-* container without going through deploy. */
function seedOrphanContainer(slug: string, prId: number, id = "orphan") {
  const name = previewContainerName(slug, prId);
  fakeDocker().running.set(name, {
    id,
    spec: {
      name,
      image: "orphan:latest",
      env: [],
      labels: {},
      networkNames: [],
    },
  });
}

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
  return postDeployAndSettle(testApp!, token, body);
}

describe("GET /v1/previews", () => {
  test("admin lists provisioned previews with coarse status", async () => {
    const { deployToken } = await setup();
    const deployed = await postDeploy(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
      app_image: "myapp:latest",
    });
    expect(deployed.settleStatus).toBe(200);

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
        db_name: "sprout_myapp_pr42",
        hostname: "pr-42.myapp.preview.example.com",
        status: "running",
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
    await fakePreviewDb!.createDatabase("sprout_myapp_pr99");
    // Container with no SQLite row → orphan-container (same catalog as sweep)
    seedOrphanContainer("myapp", 99, "c-99");

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
          db_name: "sprout_myapp_pr99",
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
    fakeDocker().listPreviewContainers = async () => {
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
      app_image: "myapp:latest",
    });

    const removedBefore = fakeDocker().removed.length;
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
        db_name: "sprout_myapp_pr42",
        hostname: "pr-42.myapp.preview.example.com",
        status: "running",
      },
    });
    expect(fakePreviewDb!.dropped).toEqual([]);
    expect(fakeDocker().removed.length).toBe(removedBefore);
    expect(fakeDocker().running.has("sprout-myapp-pr-42")).toBe(true);
  });

  test("with yes removes database, container, and sqlite row", async () => {
    const { deployToken } = await setup();
    await postDeploy(deployToken, {
      canonical_repo_id: REPO,
      pr_id: 42,
      slug: "myapp",
      hostname: "pr-42.myapp.preview.example.com",
      app_image: "myapp:latest",
    });

    const res = await postDrop({
      canonical_repo_id: REPO,
      pr_id: 42,
      yes: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["sprout_myapp_pr42"]);
    expect(fakeDocker().removed).toContain("sprout-myapp-pr-42");
    expect(await fakeDocker().listPreviewContainers()).toEqual([]);

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
      app_image: "myapp:latest",
    });
    const docker = fakeDocker();
    const realRemove = docker.removeByName.bind(docker);
    docker.removeByName = async () => {
      throw new Error("docker hung");
    };

    const res = await postDrop({
      canonical_repo_id: REPO,
      pr_id: 42,
      yes: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "removed" });
    expect(fakePreviewDb!.dropped).toEqual(["sprout_myapp_pr42"]);

    // Restore list path so doctor can see the leftover container.
    docker.removeByName = realRemove;
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
