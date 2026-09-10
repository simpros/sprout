import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ensureAdminToken, revokeToken } from "../auth/store.ts";
import { hashToken } from "../auth/tokens.ts";
import { createFakeDockerClient } from "../docker/fake.ts";
import { repos } from "../infrastructure/db/schema.ts";
import { createFakePreviewDb } from "../preview-db/fake.ts";
import { createRoutes } from "./routes.ts";
import {
  bearer,
  bindTestPreviewApp,
  createTestApp,
  createTestDb,
  postDeployToken,
  type TestApp,
  type TestDb,
} from "./test-helpers.ts";

const REPO = "https://github.com/org/repo";

let testApp: TestApp | undefined;
let testDb: TestDb | undefined;

afterEach(async () => {
  await testApp?.cleanup();
  testApp = undefined;
  await testDb?.cleanup();
  testDb = undefined;
});

describe("createRoutes", () => {
  test("GET /healthz returns ok without auth", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/healthz"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("bearer auth", () => {
  test("rejects missing token on /v1/* with 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens"),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("rejects invalid token with 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer("not-a-real-token"),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("admin token lists tokens", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(testApp.adminToken),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].scope).toBe("admin");
    expect(body.tokens[0].token).toBeUndefined();
  });

  test("creates deploy token bound to canonical repo and auto-registers repo", async () => {
    testApp = await createTestApp();
    const { status, body: created } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    expect(status).toBe(201);
    expect(created.scope).toBe("deploy");
    expect(created.canonical_repo_id).toBe(REPO);
    expect(typeof created.token).toBe("string");
    expect(created.token.length).toBeGreaterThan(10);
    expect(created.id).toBeDefined();

    const listRes = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(testApp.adminToken),
      }),
    );
    const listed = await listRes.json();
    const deploy = listed.tokens.find(
      (t: { scope: string }) => t.scope === "deploy",
    );
    expect(deploy).toBeDefined();
    expect(deploy.token).toBeUndefined();
    expect(deploy.canonical_repo_id).toBe(REPO);

    const [repo] = await testApp.db
      .select()
      .from(repos)
      .where(eq(repos.canonicalId, REPO))
      .limit(1);
    expect(repo?.slug).toBe("myapp");
  });

  test("rejects second deploy token with conflicting slug", async () => {
    testApp = await createTestApp();
    const first = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    expect(first.status).toBe(201);

    const second = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "other",
    });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "slug conflict" });
  });

  test("allows second deploy token with same slug", async () => {
    testApp = await createTestApp();
    const first = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    const second = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.token).not.toBe(first.body.token);
  });

  test("rejects unauthenticated unknown /v1 routes with 401", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/unknown"),
    );
    expect(res.status).toBe(401);
  });

  test("revokes token via DELETE /v1/admin/tokens/:id", async () => {
    testApp = await createTestApp();
    const { body: created } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });

    const deleteRes = await testApp.app.handle(
      new Request(`http://localhost/v1/admin/tokens/${created.id}`, {
        method: "DELETE",
        headers: bearer(testApp.adminToken),
      }),
    );
    expect(deleteRes.status).toBe(200);

    const useRes = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        headers: bearer(created.token),
      }),
    );
    expect(useRes.status).toBe(401);
  });

  test("deploy token cannot call admin routes", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(body.token),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("deploy token cannot call /v1/previews or /v1/doctor", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });

    for (const path of ["/v1/previews", "/v1/doctor"]) {
      const res = await testApp.app.handle(
        new Request(`http://localhost${path}`, {
          headers: bearer(body.token),
        }),
      );
      expect(res.status).toBe(403);
    }
  });

  test("deploy token cannot call /v1/drop", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/drop", {
        method: "POST",
        headers: {
          ...bearer(body.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          pr_id: 1,
          yes: true,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("admin token can reach non-admin /v1 routes", async () => {
    testApp = await createTestApp();
    const res = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        method: "POST",
        headers: {
          ...bearer(testApp.adminToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          pr_id: 1,
          slug: "myapp",
          hostname: "pr-1.example.com",
          app_image: "ghcr.io/org/myapp:test",
        }),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("deploy token can reach deploy routes", async () => {
    testApp = await createTestApp();
    const { body } = await postDeployToken(testApp, {
      canonical_repo_id: REPO,
      slug: "myapp",
    });

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/deploy", {
        method: "POST",
        headers: {
          ...bearer(body.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          canonical_repo_id: REPO,
          pr_id: 1,
          slug: "myapp",
          hostname: "pr-1.example.com",
          app_image: "ghcr.io/org/myapp:test",
        }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("ensureAdminToken", () => {
  test("configured token inserts admin hash idempotently and authenticates", async () => {
    testApp = await createTestApp("configured-admin");
    await ensureAdminToken(testApp.db, "configured-admin");
    await ensureAdminToken(testApp.db, "configured-admin");

    const generated = await ensureAdminToken(testApp.db);
    expect(generated).toEqual({ status: "existing" });

    const res = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer("configured-admin"),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("auto-generates admin token when none configured", async () => {
    testDb = await createTestDb();
    const generated = await ensureAdminToken(testDb.db);
    expect(generated.status).toBe("generated");
    if (generated.status !== "generated") throw new Error("expected generated");
    expect(generated.raw.startsWith("sprout_")).toBe(true);

    const again = await ensureAdminToken(testDb.db);
    expect(again).toEqual({ status: "existing" });

    const app = createRoutes({
      db: testDb.db,
      previewDb: createFakePreviewDb(),
      app: bindTestPreviewApp(createFakeDockerClient()),
    });
    const res = await app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(generated.raw),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("revives revoked configured admin token on ensure", async () => {
    const token = "revive-me-admin";
    testApp = await createTestApp(token);
    await revokeToken(testApp.db, hashToken(token));

    const denied = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(token),
      }),
    );
    expect(denied.status).toBe(401);

    const generated = await ensureAdminToken(testApp.db, token);
    expect(generated).toEqual({ status: "pinned", raw: token });

    const ok = await testApp.app.handle(
      new Request("http://localhost/v1/admin/tokens", {
        headers: bearer(token),
      }),
    );
    expect(ok.status).toBe(200);
  });
});
